import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env' });

const sql = postgres(process.env.POSTGRES_URL!);

async function run() {
  await sql`ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL`;
  console.log('email column is now nullable');
  await sql.end();
}

run().catch((e) => { console.error('Error:', e.message); process.exit(1); });
