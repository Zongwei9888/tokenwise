// Content shared by every asset: the logo, and a real-looking pytest -v run with one failure.
export const LOGO = `<svg viewBox="0 0 64 64" aria-hidden="true"><defs><filter id="tw-glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.1" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><rect width="64" height="64" rx="14" fill="#071E1B"/><rect x=".75" y=".75" width="62.5" height="62.5" rx="13.25" fill="none" stroke="#4FE3C1" stroke-opacity=".35" stroke-width="1.5"/><g fill="#4FE3C1" filter="url(#tw-glow)"><rect x="20" y="8" width="24" height="8"/><rect x="24" y="16" width="4" height="4"/><rect x="36" y="16" width="4" height="4"/><rect x="16" y="20" width="12" height="4"/><rect x="36" y="20" width="12" height="4"/><rect x="12" y="24" width="8" height="4"/><rect x="44" y="24" width="8" height="4"/><rect x="12" y="28" width="4" height="24"/><rect x="48" y="28" width="4" height="24"/><rect x="12" y="52" width="40" height="4"/></g><circle cx="22.5" cy="46.5" r="4.6" fill="#FFD24A" stroke="#E0A500" stroke-width="1.3"/><circle cx="22.5" cy="46.5" r="2.67" fill="none" stroke="#E0A500" stroke-width=".9" stroke-opacity=".8"/><circle cx="32" cy="46.5" r="4.6" fill="#FFD24A" stroke="#E0A500" stroke-width="1.3"/><circle cx="32" cy="46.5" r="2.67" fill="none" stroke="#E0A500" stroke-width=".9" stroke-opacity=".8"/><circle cx="41.5" cy="46.5" r="4.6" fill="#FFD24A" stroke="#E0A500" stroke-width="1.3"/><circle cx="41.5" cy="46.5" r="2.67" fill="none" stroke="#E0A500" stroke-width=".9" stroke-opacity=".8"/><circle cx="27.2" cy="37.6" r="4.6" fill="#FFD24A" stroke="#E0A500" stroke-width="1.3"/><circle cx="27.2" cy="37.6" r="2.67" fill="none" stroke="#E0A500" stroke-width=".9" stroke-opacity=".8"/><circle cx="36.8" cy="37.6" r="4.6" fill="#FFD24A" stroke="#E0A500" stroke-width="1.3"/><circle cx="36.8" cy="37.6" r="2.67" fill="none" stroke="#E0A500" stroke-width=".9" stroke-opacity=".8"/></svg>`

const MODULES = ['test_api', 'test_auth', 'test_cache', 'test_cli', 'test_config', 'test_db', 'test_export', 'test_ledger']
/** The 266-line pytest -v run the README's before/after uses: 241 tests, one failure in test_cache. */
export function pytestRun() {
  const rows = [{ t: '============================= test session starts ==============================', k: 'noise' },
    { t: 'platform darwin -- Python 3.12.4, pytest-8.3.2, pluggy-1.5.0', k: 'noise' },
    { t: 'collecting ... collected 241 items', k: 'noise' }, { t: '', k: 'noise' }]
  let n = 0
  for (const mod of MODULES) {
    for (let i = 0; i < 30; i++) {
      const pct = String(Math.floor((n / 241) * 100)).padStart(3)
      const name = mod === 'test_cache' && i === 7 ? 'test_eviction_order' : `test_case_${String(i).padStart(2, '0')}`
      const failed = name === 'test_eviction_order'
      rows.push({ t: `tests/${mod}.py::${name} ${failed ? 'FAILED' : 'PASSED'}`.padEnd(70) + `[${pct}%]`, k: failed ? 'fail' : 'pass', failed })
      n++
    }
  }
  rows.push({ t: `tests/test_ledger.py::test_case_30 PASSED`.padEnd(70) + '[100%]', k: 'pass' })
  const failure = [
    '', '=================================== FAILURES ===================================',
    '_____________________________ test_eviction_order ______________________________', '',
    '    def test_eviction_order():', "        cache = {'a': 1, 'b': 2}", '        evicted = sorted(cache)[-1]',
    ">       assert evicted == 'a', f'expected a, got {evicted}'", 'E       AssertionError: expected a, got b',
    "E       assert 'b' == 'a'", '', 'tests/test_cache.py:124: AssertionError',
    '=========================== short test summary info ============================',
    'FAILED tests/test_cache.py::test_eviction_order - AssertionError: expected a, got b',
    '========================= 1 failed, 240 passed in 0.11s =========================',
  ]
  for (const t of failure) rows.push({ t, k: t.startsWith('E ') || t.startsWith('FAILED') || t.startsWith('>') ? 'fail' : 'noise', evidence: true })
  return rows
}

/** What the model reads instead: the header, the failed row, the whole failure, the totals. */
export function compactRun() {
  return [
    { t: 'collecting ... collected 241 items', k: 'noise' },
    { t: 'tests/test_cache.py::test_eviction_order FAILED'.padEnd(70) + '[ 77%]', k: 'fail', kept: true },
    { t: '[240 PASSED rows counted, not listed]', k: 'note' },
    { t: '=================================== FAILURES ===================================', k: 'noise' },
    { t: '    def test_eviction_order():', k: 'noise' },
    { t: "        cache = {'a': 1, 'b': 2}", k: 'noise' },
    { t: '        evicted = sorted(cache)[-1]', k: 'noise' },
    { t: ">       assert evicted == 'a', f'expected a, got {evicted}'", k: 'fail', kept: true },
    { t: 'E       AssertionError: expected a, got b', k: 'fail', kept: true },
    { t: "E       assert 'b' == 'a'", k: 'fail', kept: true },
    { t: 'tests/test_cache.py:124: AssertionError', k: 'noise' },
    { t: 'FAILED tests/test_cache.py::test_eviction_order - AssertionError: expected a, got b', k: 'fail', kept: true },
    { t: '========================= 1 failed, 240 passed in 0.11s =========================', k: 'pass', kept: true },
  ]
}

export const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export const row = (r, extra = '') => `<div class="row ${r.k}${r.kept ? ' kept' : ''}${extra}">${esc(r.t) || '&nbsp;'}</div>`
