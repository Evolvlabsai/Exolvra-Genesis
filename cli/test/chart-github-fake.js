import { createServer } from 'node:http';

/** The allowed GitHub stand-in: a real HTTP server storing native relationships. */
export async function chartGitHubFake() {
  const issues = new Map(), children = new Map(), blockers = new Map(), comments = new Map(), requests = [];
  let next = 1;
  let nextComment = 1;
  const token = 'chart-test-token-never-publish';
  let fail;
  const server = createServer(async (req, res) => {
    let bytes = '';
    for await (const part of req) bytes += part;
    const body = bytes ? JSON.parse(bytes) : undefined;
    const path = new URL(req.url, 'http://localhost').pathname;
    requests.push({ method: req.method, path, body });
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(value === undefined ? '' : JSON.stringify(value)); };
    if (req.headers.authorization !== 'Bearer ' + token) return send(401, { message: 'Bad credentials' });
    if (fail?.(req.method, path, body)) return send(500, { message: 'Injected upstream failure' });
    if (path === '/user') return send(200, { login: 'chart-runner', type: 'User' });
    const commentPath = path.match(/^\/repos\/owner\/project\/issues\/comments\/(\d+)$/);
    if (commentPath && req.method === 'PATCH') {
      const comment = comments.get(Number(commentPath[1]));
      if (!comment) return send(404, { message: 'Not Found' });
      comment.body = body.body; comment.updated_at = new Date().toISOString();
      return send(200, comment);
    }
    if (path === '/repos/owner/project/issues') {
      if (req.method === 'GET') {
        const query = new URL(req.url, 'http://localhost').searchParams;
        const labels = query.get('labels')?.split(',') ?? [];
        return send(200, [...issues.values()].filter((i) => (query.get('state') === 'all' || i.state === (query.get('state') ?? 'open')) && labels.every((l) => i.labels.includes(l))));
      }
      if (req.method === 'POST') {
        const issue = seed({ ...body, number: next++ });
        return send(201, issue);
      }
    }
    const matched = path.match(/^\/repos\/owner\/project\/issues\/(\d+)(.*)$/);
    if (!matched) return send(404, { message: 'Not Found' });
    const number = Number(matched[1]), suffix = matched[2], issue = issues.get(number);
    if (!issue) return send(404, { message: 'Not Found' });
    if (!suffix) {
      if (req.method === 'GET') return send(200, issue);
      if (req.method === 'PATCH') { Object.assign(issue, body); return send(200, issue); }
    }
    if (suffix === '/comments') {
      if (req.method === 'GET') return send(200, [...comments.values()].filter((c) => c.issue === number));
      if (req.method === 'POST') {
        const comment = seedComment(number, body.body);
        return send(201, comment);
      }
    }
    if (suffix === '/assignees') {
      if (req.method === 'POST') issue.assignees = [...new Set([...issue.assignees.map((a) => a.login), ...body.assignees])].map((login) => ({ login }));
      else if (req.method === 'DELETE') issue.assignees = issue.assignees.filter((a) => !body.assignees.includes(a.login));
      return send(200, issue);
    }
    if (suffix === '/labels' && req.method === 'POST') { issue.labels = [...new Set([...issue.labels, ...body.labels])]; return send(200, issue.labels); }
    if (suffix === '/sub_issues') {
      if (req.method === 'GET') return send(200, (children.get(number) ?? []).map((n) => issues.get(n)));
      const child = [...issues.values()].find((i) => i.id === body.sub_issue_id);
      if (!child) return send(422, { message: 'Bad child id' });
      children.set(number, [...new Set([...(children.get(number) ?? []), child.number])]);
      return send(201, child);
    }
    if (suffix === '/dependencies/blocked_by') {
      if (req.method === 'GET') return send(200, (blockers.get(number) ?? []).map((n) => issues.get(n)));
      const blocker = [...issues.values()].find((i) => i.id === body.issue_id);
      if (!blocker) return send(422, { message: 'Bad dependency id' });
      blockers.set(number, [...new Set([...(blockers.get(number) ?? []), blocker.number])]);
      return send(201, blocker);
    }
    if (suffix.startsWith('/dependencies/blocked_by/') && req.method === 'DELETE') {
      const id = Number(suffix.split('/').at(-1));
      blockers.set(number, (blockers.get(number) ?? []).filter((n) => issues.get(n).id !== id));
      return send(204);
    }
    return send(404, { message: 'Not Found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  function seed(input) {
    const number = input.number ?? next++;
    next = Math.max(next, number + 1);
    const issue = { id: 10000 + number, number, title: input.title ?? 'Ticket', body: input.body ?? '', labels: input.labels ?? [], state: input.state ?? 'open', assignees: input.assignees ?? [], user: { login: 'human' }, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', html_url: origin + '/owner/project/issues/' + number, comments: 0 };
    issues.set(number, issue);
    return issue;
  }
  function seedComment(issue, body, author = 'chart-runner', at = new Date().toISOString()) {
    const id = nextComment++, comment = { id, issue, body, user: { login: author }, created_at: at, updated_at: at, html_url: origin + '/comments/' + id };
    comments.set(id, comment); return comment;
  }
  return { origin, token, issues, children, blockers, comments, requests, seed, seedComment, fail: (handler) => { fail = handler; }, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}
