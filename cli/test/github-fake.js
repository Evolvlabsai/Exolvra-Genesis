import { createServer } from 'node:http';

/*
 * A real GitHub API, small enough to run on this machine.
 *
 * The bar for this run permits exactly two stand-ins, and this is one of them:
 * the GitHub API, faked only as a real local HTTP server that the real network
 * module talks to over a real socket through its configurable host. Nothing on
 * the CLI's side of that boundary is substituted — no `fetch` is replaced, no
 * request or response object is built in process, no method is patched. What
 * `src/github.ts` does here is exactly what it does against github.com: resolve
 * a URL, check it against the configured host, open a connection, send headers,
 * read bytes back, and parse them.
 *
 * It is written to be driven by more than one suite. The runner, the queue
 * listing and the pull request surface all need issues to exist, labels to
 * move, comments to be edited in place and pull requests to be opened, so this
 * keeps that state rather than answering with fixtures: a label added by one
 * call is visible to the next, exactly as it would be.
 *
 * Three things it does on top of storing state:
 *
 * - **It records every request** — method, path, query, headers and body — so a
 *   test can assert what really went over the socket, including that the
 *   Authorization header was sent at all. A test that only checks the token is
 *   absent from an error would pass just as well if the token were never sent.
 * - **It can be told to answer badly.** `fake.reply(...)` queues one canned
 *   answer: a 500, a rate limit with a reset header, a body that is not JSON, a
 *   redirect to another host. Error paths are exercised over the socket rather
 *   than by throwing inside the module.
 * - **It checks the token**, so an unauthenticated request gets GitHub's own
 *   401 with GitHub's own message.
 */

/** The token this server accepts unless a test names another. */
export const FAKE_TOKEN = 'ghp_' + 'F4keT0kenF0rTest1ngOnly' + '00000000000000000';

/** A token with no recognisable shape, for pinning redaction by value. */
export const OPAQUE_TOKEN = 'opaque-token-value-9f3b21c4d5e6';

const JSON_TYPE = 'application/json; charset=utf-8';

/** GitHub's timestamp format. */
const stamp = (offsetMinutes = 0) =>
  new Date(Date.UTC(2026, 6, 1, 12, 0, 0) + offsetMinutes * 60_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

const key = (owner, name) => owner.toLowerCase() + '/' + name.toLowerCase();

/** Reads a request body to a string, capped so a runaway test fails fast. */
function readBody(request) {
  return new Promise((resolve, reject) => {
    let text = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      text += chunk;
      if (text.length > 4 * 1024 * 1024) reject(new Error('request body is too large'));
    });
    request.on('end', () => resolve(text));
    request.on('error', reject);
  });
}

/** What `GET /user` answers for an ordinary personal access token. */
export const FAKE_USER = { login: 'a-runner', id: 4242, type: 'User' };

/**
 * What `GET /user` answers for a GitHub App installation token.
 *
 * `null` rather than a body: GitHub refuses the endpoint outright for one of
 * those, which is a shape the caller has to survive rather than a login it has
 * to read.
 */
export const NO_IDENTITY = null;

/**
 * Starts the server and answers once it is listening.
 *
 * `token` is what it will accept; `pageSize` is how many items it puts on a
 * page before it offers a `Link` header, which is how pagination gets driven
 * without seeding hundreds of issues; `identity` is what `GET /user` answers,
 * and {@link NO_IDENTITY} makes it refuse the way it does for an installation
 * token.
 */
export async function startGitHubFake({
  token = FAKE_TOKEN,
  pageSize = 100,
  identity = FAKE_USER,
} = {}) {
  let whoTheTokenIs = identity;
  /** Every repository this server knows about. */
  const repos = new Map();
  /** Issues, keyed by `owner/name#number`. */
  const issues = new Map();
  /** Comments, in the order they were made. */
  const comments = [];
  /** Pull requests, in the order they were opened. */
  const pulls = [];
  /** Canned answers, consumed in the order they were queued. */
  const canned = [];
  /** Every request this server was sent. */
  const requests = [];
  /** Timers a delayed answer is waiting on, cleared when the server closes. */
  const timers = new Set();

  let nextCommentId = 1000;
  let nextPullNumber = 500;

  const server = createServer((request, response) => {
    // A client that walked away mid-answer is one of the things being tested
    // here, so a dead socket is an outcome rather than a crash.
    response.on('error', () => {});
    request.on('error', () => {});
    handle(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(500, { 'content-type': JSON_TYPE });
      response.end(JSON.stringify({ message: 'the fake failed: ' + error.message }));
    });
  });

  let origin = '';

  function send(response, status, body, headers = {}) {
    const text =
      body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    response.writeHead(status, {
      'content-type': JSON_TYPE,
      ...headers,
    });
    response.end(text);
  }

  /** The next canned answer for this request, if one is waiting. */
  function takeCanned(method, path) {
    for (const entry of canned) {
      if (entry.remaining <= 0) continue;
      if (entry.method !== undefined && entry.method !== method) continue;
      const matches =
        entry.path === undefined
          ? true
          : entry.path instanceof RegExp
            ? entry.path.test(path)
            : entry.path === path;
      if (!matches) continue;
      entry.remaining -= 1;
      return entry;
    }
    return undefined;
  }

  function issueJson(issue) {
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => ({ name, color: 'ededed' })),
      user: { login: issue.author },
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      html_url:
        'https://github.com/' + issue.repo + '/issues/' + issue.number,
      comments: comments.filter((c) => c.issue === issue.key).length,
      ...(issue.isPullRequest
        ? { pull_request: { url: 'https://api.github.com/pulls/' + issue.number } }
        : {}),
    };
  }

  function commentJson(comment) {
    return {
      id: comment.id,
      body: comment.body,
      user: { login: comment.author },
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
      html_url: 'https://github.com/' + comment.repo + '#issuecomment-' + comment.id,
    };
  }

  function pullJson(pull) {
    return {
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      draft: pull.draft,
      head: { ref: pull.head },
      base: { ref: pull.base },
      html_url: 'https://github.com/' + pull.repo + '/pull/' + pull.number,
    };
  }

  /** One page of `items`, with the `Link` header GitHub would send. */
  function page(response, url, items) {
    const perPage = Math.min(Number(url.searchParams.get('per_page')) || pageSize, pageSize);
    const number = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const start = (number - 1) * perPage;
    const slice = items.slice(start, start + perPage);
    const headers = {};
    if (start + perPage < items.length) {
      const next = new URL(url.toString());
      next.searchParams.set('page', String(number + 1));
      headers.link = '<' + next.toString() + '>; rel="next"';
    }
    send(response, 200, slice, headers);
  }

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', origin);
    // Decoded one segment at a time, so a label with a slash in it stays one
    // segment: percent-encoding is what makes it one, and undoing that over the
    // whole path would put it back as two.
    const segments = url.pathname
      .split('/')
      .filter((piece) => piece !== '')
      .map((piece) => decodeURIComponent(piece));
    const path = '/' + segments.join('/');
    const raw = url.pathname;
    const body = await readBody(request);
    let json;
    try {
      json = body === '' ? undefined : JSON.parse(body);
    } catch {
      json = undefined;
    }
    requests.push({
      method: request.method ?? '',
      path,
      rawPath: raw,
      url: url.toString(),
      query: Object.fromEntries(url.searchParams.entries()),
      headers: { ...request.headers },
      body,
      json,
    });

    const method = request.method ?? '';
    const ready = takeCanned(method, path);
    if (ready !== undefined) {
      const answer = () => {
        // `hang` sends the head and then nothing: the shape of an answer that
        // announces a body which never arrives.
        if (ready.hang === true) {
          response.writeHead(ready.status, { 'content-type': JSON_TYPE, ...(ready.headers ?? {}) });
          response.flushHeaders();
          return;
        }
        send(response, ready.status, ready.body, ready.headers ?? {});
      };
      if (ready.delayMs !== undefined && ready.delayMs > 0) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          answer();
        }, ready.delayMs);
        timers.add(timer);
        return;
      }
      answer();
      return;
    }

    if (request.headers.authorization !== 'Bearer ' + token) {
      send(response, 401, {
        message: 'Bad credentials',
        documentation_url: 'https://docs.github.com/rest',
      });
      return;
    }

    /* GET /user — who the token is */
    if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
      if (whoTheTokenIs === null) {
        // What an installation token is told, in GitHub's own words.
        send(response, 403, {
          message: 'Resource not accessible by integration',
          documentation_url:
            'https://docs.github.com/rest/users/users#get-the-authenticated-user',
        });
        return;
      }
      send(response, 200, whoTheTokenIs);
      return;
    }

    // Every route below is /repos/{owner}/{repo}/…
    if (segments[0] !== 'repos' || segments.length < 3) {
      send(response, 404, {
        message: 'Not Found',
        documentation_url: 'https://docs.github.com/rest',
      });
      return;
    }
    const owner = segments[1];
    const name = segments[2];
    const slug = owner + '/' + name;
    const repo = repos.get(key(owner, name));
    const rest = segments.slice(3);

    if (repo === undefined) {
      send(response, 404, {
        message: 'Not Found',
        documentation_url: 'https://docs.github.com/rest/repos/repos#get-a-repository',
      });
      return;
    }

    const of = (number) => issues.get(key(owner, name) + '#' + number);

    /* GET /repos/{owner}/{repo} */
    if (rest.length === 0 && method === 'GET') {
      send(response, 200, {
        name: repo.name,
        owner: { login: repo.owner },
        default_branch: repo.defaultBranch,
        private: repo.isPrivate,
        html_url: 'https://github.com/' + slug,
      });
      return;
    }

    /* GET /repos/{owner}/{repo}/branches?protected=true */
    if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      const wanted = url.searchParams.get('protected');
      const branches = repo.branches.filter(
        (branch) => wanted !== 'true' || branch.protected,
      );
      page(
        response,
        url,
        branches.map((branch) => ({ name: branch.name, protected: branch.protected })),
      );
      return;
    }

    /* GET /repos/{owner}/{repo}/issues */
    if (rest.length === 1 && rest[0] === 'issues' && method === 'GET') {
      const wanted = (url.searchParams.get('labels') ?? '')
        .split(',')
        .filter((label) => label !== '');
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let listed = [...issues.values()].filter((issue) => issue.repo === slug);
      if (state !== 'all') listed = listed.filter((issue) => issue.state === state);
      if (wanted.length > 0) {
        listed = listed.filter((issue) =>
          wanted.every((label) => issue.labels.includes(label)),
        );
      }
      listed.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number);
      if (direction === 'desc') listed.reverse();
      page(response, url, listed.map(issueJson));
      return;
    }

    /* /repos/{owner}/{repo}/issues/comments/{id} — editing a comment in place */
    if (rest.length === 3 && rest[0] === 'issues' && rest[1] === 'comments') {
      const id = Number(rest[2]);
      const comment = comments.find((entry) => entry.id === id);
      if (comment === undefined) {
        send(response, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'PATCH') {
        comment.body = typeof json?.body === 'string' ? json.body : comment.body;
        comment.updatedAt = stamp(60);
        send(response, 200, commentJson(comment));
        return;
      }
      if (method === 'GET') {
        send(response, 200, commentJson(comment));
        return;
      }
    }

    /* /repos/{owner}/{repo}/issues/{number}… */
    if (rest.length >= 2 && rest[0] === 'issues') {
      const number = Number(rest[1]);
      const issue = of(number);
      if (issue === undefined) {
        send(response, 404, { message: 'Not Found' });
        return;
      }
      const tail = rest.slice(2);

      if (tail.length === 0 && method === 'GET') {
        send(response, 200, issueJson(issue));
        return;
      }

      if (tail.length === 1 && tail[0] === 'comments') {
        if (method === 'GET') {
          page(
            response,
            url,
            comments.filter((entry) => entry.issue === issue.key).map(commentJson),
          );
          return;
        }
        if (method === 'POST') {
          if (typeof json?.body !== 'string' || json.body === '') {
            send(response, 422, { message: 'Validation Failed' });
            return;
          }
          nextCommentId += 1;
          const comment = {
            id: nextCommentId,
            issue: issue.key,
            repo: slug,
            body: json.body,
            author: 'exolvra-genesis',
            createdAt: stamp(30),
            updatedAt: stamp(30),
          };
          comments.push(comment);
          send(response, 201, commentJson(comment));
          return;
        }
      }

      if (tail[0] === 'labels') {
        if (method === 'POST' && tail.length === 1) {
          const added = Array.isArray(json?.labels) ? json.labels : [];
          for (const label of added) {
            if (typeof label === 'string' && !issue.labels.includes(label)) {
              issue.labels.push(label);
            }
          }
          send(
            response,
            200,
            issue.labels.map((label) => ({ name: label, color: 'ededed' })),
          );
          return;
        }
        if (method === 'DELETE' && tail.length === 2) {
          const label = tail[1];
          const at = issue.labels.indexOf(label);
          if (at === -1) {
            send(response, 404, { message: 'Label does not exist' });
            return;
          }
          issue.labels.splice(at, 1);
          send(
            response,
            200,
            issue.labels.map((name) => ({ name, color: 'ededed' })),
          );
          return;
        }
      }
    }

    /* PATCH /repos/{owner}/{repo}/pulls/{number} — editing one in place */
    if (rest.length === 2 && rest[0] === 'pulls' && method === 'PATCH') {
      const number = Number(rest[1]);
      const pull = pulls.find((entry) => entry.repo === slug && entry.number === number);
      if (pull === undefined) {
        send(response, 404, { message: 'Not Found' });
        return;
      }
      // Only the fields that arrived: what the caller left out stays as it was,
      // which is the behaviour the caller is relying on.
      if (typeof json?.title === 'string') pull.title = json.title;
      if (typeof json?.body === 'string') pull.body = json.body;
      send(response, 200, pullJson(pull));
      return;
    }

    /* /repos/{owner}/{repo}/pulls */
    if (rest.length === 1 && rest[0] === 'pulls') {
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const head = url.searchParams.get('head');
        const base = url.searchParams.get('base');
        let listed = pulls.filter((pull) => pull.repo === slug);
        if (state !== 'all') listed = listed.filter((pull) => pull.state === state);
        if (head !== null) {
          listed = listed.filter((pull) => head === owner + ':' + pull.head);
        }
        if (base !== null) listed = listed.filter((pull) => pull.base === base);
        page(response, url, listed.map(pullJson));
        return;
      }
      if (method === 'POST') {
        const title = typeof json?.title === 'string' ? json.title : '';
        const head = typeof json?.head === 'string' ? json.head : '';
        const base = typeof json?.base === 'string' ? json.base : '';
        if (title === '' || head === '' || base === '') {
          send(response, 422, {
            message: 'Validation Failed',
            errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }],
          });
          return;
        }
        nextPullNumber += 1;
        const pull = {
          number: nextPullNumber,
          repo: slug,
          title,
          head,
          base,
          body: typeof json?.body === 'string' ? json.body : '',
          draft: json?.draft === true,
          state: 'open',
        };
        pulls.push(pull);
        send(response, 201, pullJson(pull));
        return;
      }
    }

    send(response, 404, {
      message: 'Not Found',
      documentation_url: 'https://docs.github.com/rest',
    });
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  origin = 'http://127.0.0.1:' + address.port;

  return {
    origin,
    token,
    requests,
    port: address.port,

    /** Adds a repository, with the branches it reports as protected. */
    seedRepo({
      owner,
      name,
      defaultBranch = 'main',
      isPrivate = false,
      protectedBranches = ['main'],
      branches = ['main'],
    }) {
      const all = [...new Set([...branches, ...protectedBranches])];
      repos.set(key(owner, name), {
        owner,
        name,
        defaultBranch,
        isPrivate,
        branches: all.map((branch) => ({
          name: branch,
          protected: protectedBranches.includes(branch),
        })),
      });
      return this;
    },

    /** Adds an issue, and any comments it already carries. */
    seedIssue({
      owner,
      name,
      number,
      title = 'An issue',
      body = 'Do the thing.',
      state = 'open',
      labels = [],
      author = 'a-maintainer',
      minutes = 0,
      isPullRequest = false,
      comments: seeded = [],
    }) {
      const slug = owner + '/' + name;
      const id = key(owner, name) + '#' + number;
      issues.set(id, {
        key: id,
        repo: slug,
        number,
        title,
        body,
        state,
        labels: [...labels],
        author,
        createdAt: stamp(minutes),
        updatedAt: stamp(minutes),
        isPullRequest,
      });
      for (const [index, comment] of seeded.entries()) {
        nextCommentId += 1;
        comments.push({
          id: nextCommentId,
          issue: id,
          repo: slug,
          body: typeof comment === 'string' ? comment : comment.body,
          author: typeof comment === 'string' ? 'a-maintainer' : (comment.author ?? 'a-maintainer'),
          createdAt: stamp(minutes + index + 1),
          updatedAt: stamp(minutes + index + 1),
        });
      }
      return this;
    },

    /**
     * Changes what `GET /user` answers from here on.
     *
     * {@link NO_IDENTITY} refuses the endpoint the way GitHub does for an
     * installation token; any object is answered as the body.
     */
    setIdentity(next) {
      whoTheTokenIs = next;
      return this;
    },

    /** Adds a pull request that already exists. */
    seedPull({ owner, name, number, title = 'A change', head, base = 'main', draft = false }) {
      pulls.push({
        number,
        repo: owner + '/' + name,
        title,
        head,
        base,
        body: '',
        draft,
        state: 'open',
      });
      return this;
    },

    /** The labels an issue carries right now, as the server holds them. */
    labelsOf(owner, name, number) {
      return [...(issues.get(key(owner, name) + '#' + number)?.labels ?? [])];
    },

    /** The comments on an issue right now, as the server holds them. */
    commentsOn(owner, name, number) {
      const id = key(owner, name) + '#' + number;
      return comments.filter((comment) => comment.issue === id).map((comment) => ({ ...comment }));
    },

    /** Every pull request opened so far. */
    pullsOpened() {
      return pulls.map((pull) => ({ ...pull }));
    },

    /**
     * Queues one answer that overrides the routes above.
     *
     * `path` is an exact pathname or a regular expression; `times` is how many
     * requests it answers before the routes take over again. `delayMs` waits
     * before answering, and `hang` sends the head and never a body.
     */
    reply({ method, path, status = 200, body, headers, times = 1, delayMs, hang }) {
      canned.push({ method, path, status, body, headers, remaining: times, delayMs, hang });
      return this;
    },

    /** Forgets every request recorded so far. */
    clearRequests() {
      requests.length = 0;
      return this;
    },

    /** The last request the server was sent. */
    lastRequest() {
      return requests[requests.length - 1];
    },

    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
