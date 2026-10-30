// One-time operator command (uses the owner DB connection, not the API): create a municipality and make an existing user its admin.
// Usage: ADMIN_DATABASE_URL=... tsx src/bootstrap.ts "<municipality name>" <issuer> <subject>
import pg from 'pg';
const [name, issuer, subject] = process.argv.slice(2);
if (!name || !issuer || !subject) throw new Error('usage: bootstrap <municipality> <issuer> <subject>');
const c = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
await c.connect();
const org = await c.query(`INSERT INTO orgs (kind,name) VALUES ('municipality',$1) ON CONFLICT ((COALESCE(owner_org_id, '00000000-0000-0000-0000-000000000000'::uuid)), kind, name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [name]);
const u = await c.query(`INSERT INTO users (issuer,subject,alias) VALUES ($1,$2,'admin') ON CONFLICT (issuer,subject) DO UPDATE SET issuer=EXCLUDED.issuer RETURNING id`, [issuer, subject]);
await c.query(`INSERT INTO memberships (user_id, org_id, role) VALUES ($1,$2,'admin') ON CONFLICT DO NOTHING`, [u.rows[0].id, org.rows[0].id]);
console.log('municipality', org.rows[0].id, 'admin user', u.rows[0].id);
await c.end();
