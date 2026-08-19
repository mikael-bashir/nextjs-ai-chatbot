-- Forces Mathlib and Architect to be built into this project's LEAN_PATH.
-- The REPL daemons import both at boot to create the warm environment every
-- /compile request runs against.
import Mathlib
import Architect
