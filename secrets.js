// Private configuration lives outside the repository.
// Lookup order: environment variable, then a Render Secret File (/etc/secrets/<file>),
// then ./private/<file> for local development (git-ignored).

const fs = require('fs');
const path = require('path');

function readSecret(envName, fileName) {
  if (process.env[envName]) return process.env[envName];
  const candidates = [
    process.env[`${envName}_FILE`],
    path.join('/etc/secrets', fileName),
    path.join(__dirname, 'private', fileName),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (e) {
      // try the next location
    }
  }
  return '';
}

function readList(envName, fileName) {
  return readSecret(envName, fileName)
    .split(/[\n,]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

module.exports = { readSecret, readList };
