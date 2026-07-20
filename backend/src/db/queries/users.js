export async function getUserById(db, id) {
  const { rows } = await db.query(`SELECT id, email FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function getUserByEmail(db, email) {
  const { rows } = await db.query(
    `SELECT id, email, password_hash AS "passwordHash" FROM users WHERE email = $1`,
    [email]
  );
  return rows[0] || null;
}

export async function createUser(db, email, passwordHash) {
  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email`,
    [email, passwordHash]
  );
  return rows[0];
}
