// Runs every test file listed below.
//   Terminal:  dev/run-tests.sh            (jsc; exit code 1 on any failure)
//   Browser:   http://localhost:8765/dev/tests/
import { runAll } from './harness.js';

// ===================== TEST FILES =====================
// Each area adds ONE line for its own file. Keep this list in one place.
import './core.test.js';        // CORE builder
import './data.test.js';        // DATA builder
// import './card.test.js';     // CARD builder
import './stickers.test.js';    // STICKERS builder
// import './page.test.js';     // PAGE builder
import './integration.test.js'; // curves, stock note, lookalike, X-post wording
import './markethours.test.js'; // off-hours mode calendar
import './offhours.test.js';    // off-hours mode (switched off by default)
import './board.test.js';       // Stock-Paired Board (switched off by default)
// =================== END OF TEST FILES ================

const inBrowser = typeof document !== 'undefined';   // note: browsers also have a print() (it prints the page)

function browserReporter() {
  const list = document.getElementById('results');
  const total = document.getElementById('total');
  if (total) total.textContent = 'Running…';
  return {
    each(res) {
      const li = document.createElement('li');
      li.className = res.ok ? 'pass' : 'fail';
      li.textContent = (res.ok ? '✓ ' : '✗ ') + res.name + (res.ok ? '' : ' — ' + res.error);
      list.appendChild(li);
    },
    done(s) {
      const line = s.failed ? 'FAIL — ' + s.failed + ' of ' + s.total + ' failed' : 'PASS — all ' + s.total + ' passed';
      total.textContent = line;
      total.className = s.failed ? 'fail' : 'pass';
      document.title = (s.failed ? '✗ ' : '✓ ') + 'Tests';
    },
  };
}

function terminalReporter() {
  return {
    each(res) { print((res.ok ? '  ✓ ' : '  ✗ ') + res.name + (res.ok ? '' : '\n      ' + res.error)); },
    done(s) {
      print('');
      print(s.failed ? 'RESULT: FAIL (' + s.failed + ' of ' + s.total + ' failed)' : 'RESULT: PASS (' + s.total + ' tests)');
    },
  };
}

const reporter = inBrowser ? browserReporter() : terminalReporter();
runAll(reporter.each).then(reporter.done, (e) => {
  if (inBrowser) document.getElementById('total').textContent = 'Runner crashed: ' + e;
  else print('RESULT: CRASH ' + e);
});
