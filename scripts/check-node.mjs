// Fail fast with a clear message when the wrong Node version is active.
// (Vite 8 / Vitest 5 need 22.12+; Fastify 5 needs 20.19+; Node 18 lacks the
// global `crypto`, which crashed the backend on session.start.)
const [major, minor] = process.versions.node.split('.').map(Number);
const ok = major > 22 || (major === 22 && minor >= 12);
if (!ok) {
  console.error(`\n[live-subtitle-translator] Node ${process.versions.node} is not supported. Need Node >= 22.12.\n` +
    `Run \`nvm use\` in this terminal (reads .nvmrc) and try again.\n`);
  process.exit(1);
}
