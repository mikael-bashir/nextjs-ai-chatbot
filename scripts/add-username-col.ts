import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env' });

const sql = postgres(process.env.POSTGRES_URL!);

async function run() {
  await sql`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "username" varchar(32)`;
  console.log('Column added');
  try {
    await sql`ALTER TABLE "User" ADD CONSTRAINT "User_username_unique" UNIQUE("username")`;
    console.log('Unique constraint added');
  } catch (e: any) {
    if (e.code === '42P07') console.log('Constraint already exists');
    else throw e;
  }
  await sql.end();
}

run().catch((e) => { console.error('Error:', e.message); process.exit(1); });
