import { loadConfig } from '../config.js';
import { createPool, inTransaction } from '../db/pool.js';
import { discordAudit } from './audit.js';
import { z } from 'zod';

const config=loadConfig();
if(config.NODE_ENV === 'production') throw new Error('Local administrator bootstrap is disabled in production.');
const email=z.string().trim().email().transform((value) => value.toLowerCase()).parse(process.env.ADMIN_EMAIL);
const pool=createPool(config.DATABASE_URL);
try {
  await inTransaction(pool,async (db) => {
    const user=(await db.query<{id:string}>('SELECT id FROM app_users WHERE email=$1 AND disabled_at IS NULL FOR UPDATE',[email])).rows[0];
    if(!user) throw new Error('Register the local account before granting local administrator access.');
    await db.query("UPDATE app_users SET role='admin',updated_at=now() WHERE id=$1",[user.id]);
    await discordAudit(db,'LOCAL_ADMIN_GRANTED',user.id,{scope:'local-development'});
  });
  process.stdout.write('Local administrator access granted and audited.\n');
} finally { await pool.end(); }
