"""Warm Lean REPL daemon pool.

Each worker is a `leanprover-community/repl` subprocess started inside the
gateway Lake project (`lake env repl`), initialised once with the service's
import header (e.g. `import Mathlib\nimport Architect`). That initial import
is the expensive part — several GB of Mathlib oleans mapped into RAM over
~1-2 minutes — after which every `/compile` request elaborates against the
warm environment (env 0) in seconds.

This is the "multiple Lean daemons, full Mathlib in RAM" layer: POOL_SIZE
controls how many daemons run concurrently; requests queue for a free one.
A worker that times out or dies is killed and respawned in the background,
so one poisoned request cannot brick the service.
"""

import asyncio
import json
import os
import time

REPL_BIN = os.environ.get("REPL_BIN", "/opt/repl/.lake/build/bin/repl")
PROJECT_DIR = os.environ.get("GATEWAY_DIR", "/opt/gateway")
POOL_SIZE = int(os.environ.get("POOL_SIZE", "2"))
# NOTE: Dockerfile `ENV FOO="a\nb"` stores a LITERAL backslash-n, not a
# newline — Docker does not process escapes there. Lean then parses only the
# first import and errors on the rest (silently, since the REPL still returns
# an env). Decode escaped newlines so both spellings work.
IMPORTS = os.environ.get("REPL_IMPORTS", "import Mathlib\nimport Architect").replace("\\n", "\n")
# Lazy mode: don't warm daemons at boot; spawn on first request and shut down
# after IDLE_SHUTDOWN_S of inactivity (Leak XIV uses this — it is called once
# per solved blueprint, so keeping 5 GB resident around the clock is waste).
LAZY = os.environ.get("LAZY", "0") == "1"
IDLE_SHUTDOWN_S = int(os.environ.get("IDLE_SHUTDOWN_S", "900"))
INIT_TIMEOUT_S = int(os.environ.get("INIT_TIMEOUT_S", "600"))


class ReplWorker:
    def __init__(self, wid: int):
        self.wid = wid
        self.proc: asyncio.subprocess.Process | None = None
        self.ready = False
        self.last_used = time.monotonic()

    async def start(self):
        self.ready = False
        self.proc = await asyncio.create_subprocess_exec(
            "lake", "env", REPL_BIN,
            cwd=PROJECT_DIR,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        # Initial import — creates env 0 that all requests build on.
        resp = await self._roundtrip({"cmd": IMPORTS}, timeout=INIT_TIMEOUT_S)
        if "env" not in resp:
            raise RuntimeError(f"REPL worker {self.wid} failed to import: {resp}")
        # The REPL still hands back an env when the import header itself has
        # errors, so a broken header (a missing package, a mangled newline)
        # would otherwise boot a daemon that is silently missing an import and
        # only fails much later, at compile time. Refuse to go ready instead.
        import_errors = [m.get("data", "") for m in (resp.get("messages") or [])
                         if m.get("severity") == "error"]
        if import_errors:
            raise RuntimeError(
                f"REPL worker {self.wid} import header errored ({IMPORTS!r}): {import_errors}")
        self.base_env = resp["env"]
        self.ready = True

    async def _roundtrip(self, obj: dict, timeout: float) -> dict:
        assert self.proc and self.proc.stdin and self.proc.stdout
        payload = json.dumps(obj, ensure_ascii=False) + "\n\n"
        self.proc.stdin.write(payload.encode())
        await self.proc.stdin.drain()

        async def read_response() -> dict:
            buf: list[str] = []
            while True:
                line = (await self.proc.stdout.readline()).decode()
                if line == "":  # EOF — process died
                    raise RuntimeError("REPL process exited")
                if line.strip() == "" and buf:
                    text = "".join(buf)
                    try:
                        return json.loads(text)
                    except json.JSONDecodeError:
                        # Multi-line JSON not yet complete — keep reading.
                        buf.append(line)
                        continue
                if line.strip() != "":
                    buf.append(line)

        return await asyncio.wait_for(read_response(), timeout=timeout)

    async def run_cmd(self, code: str, timeout: float) -> dict:
        self.last_used = time.monotonic()
        return await self._roundtrip({"cmd": code, "env": self.base_env}, timeout=timeout)

    async def kill(self):
        self.ready = False
        if self.proc:
            try:
                self.proc.kill()
                await self.proc.wait()
            except ProcessLookupError:
                pass
        self.proc = None


class ReplPool:
    def __init__(self):
        self.workers = [ReplWorker(i) for i in range(POOL_SIZE)]
        self.free: asyncio.Queue[ReplWorker] = asyncio.Queue()
        self.started = False
        self._warming = 0

    async def boot(self):
        """Warm workers sequentially in the background (parallel warm-up would
        double peak RAM while both map Mathlib)."""
        if self.started:
            return
        self.started = True
        if not LAZY:
            asyncio.create_task(self._warm_all())
        if LAZY and IDLE_SHUTDOWN_S > 0:
            asyncio.create_task(self._idle_reaper())

    async def _warm_all(self):
        for w in self.workers:
            await self._warm(w)

    async def _warm(self, w: ReplWorker):
        self._warming += 1
        try:
            await w.start()
            await self.free.put(w)
        except Exception as e:
            print(f"[pool] worker {w.wid} failed to warm: {e}", flush=True)
        finally:
            self._warming -= 1

    async def _idle_reaper(self):
        while True:
            await asyncio.sleep(60)
            for w in self.workers:
                if w.ready and time.monotonic() - w.last_used > IDLE_SHUTDOWN_S:
                    # Drain it from the free queue if present, then kill.
                    drained = []
                    while not self.free.empty():
                        x = self.free.get_nowait()
                        if x is not w:
                            drained.append(x)
                    for x in drained:
                        self.free.put_nowait(x)
                    await w.kill()
                    print(f"[pool] worker {w.wid} idle — shut down", flush=True)

    def status(self) -> dict:
        return {
            "pool": POOL_SIZE,
            "ready": sum(1 for w in self.workers if w.ready),
            "warming": self._warming,
            "lazy": LAZY,
        }

    async def run(self, code: str, timeout: float) -> dict:
        """Run one command on a free worker. Spawns lazily if needed. On
        timeout the worker is killed and respawned in the background — the
        caller gets a structured timeout error, not a hung connection."""
        # Lazy spawn: if nothing is ready or warming, warm the first dead one.
        if self.free.empty() and self._warming == 0:
            for w in self.workers:
                if not w.ready:
                    asyncio.create_task(self._warm(w))
                    break
        try:
            worker = await asyncio.wait_for(self.free.get(), timeout=INIT_TIMEOUT_S)
        except asyncio.TimeoutError:
            raise RuntimeError("no REPL worker became available (still warming?)")
        try:
            resp = await worker.run_cmd(code, timeout=timeout)
            await self.free.put(worker)
            return resp
        except (asyncio.TimeoutError, RuntimeError) as e:
            await worker.kill()
            asyncio.create_task(self._warm(worker))
            raise RuntimeError(f"lean daemon timeout/crash: {e}")
