import { makeEnv, answerQuestion } from './harness.mjs';
import { issueCaptcha, issueRingCaptcha, verifyCaptcha } from '../src/abuse.js';

let passed = 0;
let failed = 0;
function check(name, ok) {
  if (ok) passed++;
  else { failed++; console.error('FAIL:', name); }
}

const db = makeEnv().DB;
for (const secret of ['', 'short']) {
  const env = { CAPTCHA_SECRET: secret };
  let regularRejected = false;
  let ringRejected = false;
  try { await issueCaptcha(db, env); } catch (error) { regularRejected = /CAPTCHA_SECRET/.test(error.message); }
  try { await issueRingCaptcha(db, env); } catch (error) { ringRejected = /CAPTCHA_SECRET/.test(error.message); }
  check('regular CAPTCHA fails closed for missing/short secret', regularRejected);
  check('ring CAPTCHA fails closed for missing/short secret', ringRejected);
}

const env = makeEnv();
const challenge = await issueCaptcha(env.DB, env);
check('valid secret issues CAPTCHA', Boolean(challenge.token));
check('valid answer verifies once', await verifyCaptcha(env.DB, env, challenge.token, answerQuestion(challenge.q)));
check('replay is rejected', !(await verifyCaptcha(env.DB, env, challenge.token, answerQuestion(challenge.q))));
check('malformed token is rejected', !(await verifyCaptcha(env.DB, env, 'bad', '1')));

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
