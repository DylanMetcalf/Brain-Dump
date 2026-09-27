// `npm run simulate` — prints the 30-day simulation report and transcript.
import { runSimulation } from './simulation.js';

const r = await runSimulation();
if (process.argv.includes('--transcript')) console.log(r.transcript.join('\n'), '\n');
console.log(`Brain Dump — 30-day simulation
  utterances:                 ${r.utterances}
  checks passed:              ${r.passed}/${r.checks}
  verified actions:           ${r.verifiedActions}
  questions asked:            ${r.questionsAsked}
  unnecessary confirmations:  ${r.unnecessaryConfirmations}
  false claims:               ${r.falseClaims}
  duplicates:                 ${r.duplicates}
  thoughts lost:              ${r.thoughtsLost}
  notifications:              ${r.notifications}
  suggestions offered:        ${r.suggestionsOffered}
  MENTAL LOAD REMOVED (score): ${r.mentalLoadScore}`);
for (const f of r.failures) console.log(`  ✗ day ${f.day} ${f.label}: ${f.why}\n      > ${f.text ?? ''}\n      ${f.reply ?? ''}`);
process.exit(r.failures.length ? 1 : 0);
