const jwt = require('jsonwebtoken');
const config = require('./config');

function login(password) {
  if (password !== config.jwtSecret) return null;
  return jwt.sign({ auth: true }, config.jwtSecret, { expiresIn: '30d' });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    jwt.verify(header.slice(7), config.jwtSecret);
    next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

module.exports = { login, authMiddleware };
