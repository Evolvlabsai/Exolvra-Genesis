// The transcript fixtures describe a Unicode-capable terminal. Make that test
// capability explicit on Windows, even when the test runner itself uses pipes.
// Production prompts still detect the operator's actual terminal capabilities.
if (process.platform === 'win32') process.env.WT_SESSION ??= 'genesis-test-terminal';
