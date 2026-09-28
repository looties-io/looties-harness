// Best-effort shell parsing for the guard hook. It is a tripwire, not a
// sandbox: it splits a command line into simple commands, unwraps the common
// wrappers, and reports redirection targets. A command built to hide from it
// (eval of an encoded string, a script file) gets through; the other safety
// nets in docs/standards/agent-harness.md exist for that.

const OPERATORS = ['&&', '||', ';;', '|&', ';', '|', '&', '\n'];
const REDIRECT = /^(\d*|&)(>>?|<|>\||>&|<&|&>>?)$/;

// Splits `input` into simple commands. Each command is { argv, env, redirects, stdin },
// where `stdin` holds the body of its here-documents.
// Command substitutions ($(...) and backticks) are parsed as extra commands.
export function parseCommands(input, depth = 0) {
  if (depth > 4 || typeof input !== 'string') return [];
  const commands = [];
  const nested = [];
  let tokens = [];
  let current = '';
  let started = false;
  let index = 0;
  const heredocs = [];
  let stdin = [];

  const pushToken = () => {
    if (started) tokens.push(current);
    current = '';
    started = false;
  };
  const endCommand = () => {
    pushToken();
    if (tokens.length > 0) commands.push(...finish(tokens, depth, stdin.join('\n')));
    tokens = [];
    stdin = [];
  };

  while (index < input.length) {
    const char = input[index];
    if (char === '\\' && index + 1 < input.length) {
      if (input[index + 1] !== '\n') {
        current += input[index + 1];
        started = true;
      }
      index += 2;
      continue;
    }
    if (char === "'") {
      const end = input.indexOf("'", index + 1);
      const stop = end === -1 ? input.length : end;
      current += input.slice(index + 1, stop);
      started = true;
      index = stop + 1;
      continue;
    }
    if (char === '"') {
      let cursor = index + 1;
      while (cursor < input.length && input[cursor] !== '"') {
        if (input[cursor] === '\\' && cursor + 1 < input.length) {
          current += input[cursor + 1];
          cursor += 2;
          continue;
        }
        if (input[cursor] === '$' && input[cursor + 1] === '(') {
          const end = matchParen(input, cursor + 1);
          nested.push(input.slice(cursor + 2, end));
          current += input.slice(cursor, end + 1);
          cursor = end + 1;
          continue;
        }
        if (input[cursor] === '`') {
          const end = input.indexOf('`', cursor + 1);
          const stop = end === -1 ? input.length : end;
          nested.push(input.slice(cursor + 1, stop));
          current += input.slice(cursor, stop + 1);
          cursor = stop + 1;
          continue;
        }
        current += input[cursor];
        cursor += 1;
      }
      started = true;
      index = cursor + 1;
      continue;
    }
    if (char === '$' && input[index + 1] === '(') {
      const end = matchParen(input, index + 1);
      nested.push(input.slice(index + 2, end));
      current += input.slice(index, end + 1);
      started = true;
      index = end + 1;
      continue;
    }
    if (char === '`') {
      const end = input.indexOf('`', index + 1);
      const stop = end === -1 ? input.length : end;
      nested.push(input.slice(index + 1, stop));
      started = true;
      index = stop + 1;
      continue;
    }
    if (char === '#' && !started) {
      const end = input.indexOf('\n', index);
      index = end === -1 ? input.length : end;
      continue;
    }
    if (char === '<' && input[index + 1] === '<' && input[index + 2] !== '<') {
      // Here-document: its body is data, never commands.
      const match = /^<<-?\s*(['"]?)([A-Za-z0-9_.-]+)\1/.exec(input.slice(index));
      if (match) {
        pushToken();
        heredocs.push({ strip: match[0].startsWith('<<-'), delimiter: match[2] });
        index += match[0].length;
        continue;
      }
    }
    if (char === '\n' && heredocs.length > 0) {
      let cursor = index + 1;
      for (const heredoc of heredocs.splice(0)) {
        const lines = [];
        while (cursor < input.length) {
          const end = input.indexOf('\n', cursor);
          const stop = end === -1 ? input.length : end;
          const line = input.slice(cursor, stop);
          cursor = stop + 1;
          if ((heredoc.strip ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) break;
          lines.push(line);
        }
        stdin.push(lines.join('\n'));
      }
      endCommand();
      index = cursor;
      continue;
    }
    if (char === '&' && input[index + 1] === '>' && !started) {
      pushToken();
      const glued = input[index + 2] === '>' ? '&>>' : '&>';
      tokens.push(glued);
      index += glued.length;
      continue;
    }
    const operator = OPERATORS.find((candidate) => input.startsWith(candidate, index));
    if (operator) {
      endCommand();
      index += operator.length;
      continue;
    }
    // An unquoted `)` ends the command even glued to a word: `(git push)`.
    if (char === ')' || ((char === '(' || char === '{' || char === '}') && !started && (char === '(' || /[\s;]/.test(input[index + 1] ?? ' ')))) {
      endCommand();
      index += 1;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\r') {
      pushToken();
      index += 1;
      continue;
    }
    if ((char === '>' || char === '<') && !started) {
      // A redirection operator glued to its target, such as `>file` or `2>>log`.
      let cursor = index;
      while (cursor < input.length && '<>&|'.includes(input[cursor])) cursor += 1;
      pushToken();
      tokens.push(input.slice(index, cursor));
      index = cursor;
      continue;
    }
    if ((char === '>' || char === '<') && /^\d+$|^&$/.test(current)) {
      let cursor = index;
      while (cursor < input.length && '<>&|'.includes(input[cursor])) cursor += 1;
      current += input.slice(index, cursor);
      pushToken();
      index = cursor;
      continue;
    }
    current += char;
    started = true;
    index += 1;
  }
  endCommand();
  for (const inner of nested) commands.push(...parseCommands(inner, depth + 1));
  return commands;
}

function matchParen(input, open) {
  let level = 0;
  for (let cursor = open; cursor < input.length; cursor += 1) {
    if (input[cursor] === '(') level += 1;
    if (input[cursor] === ')') {
      level -= 1;
      if (level === 0) return cursor;
    }
  }
  return input.length;
}

const WRAPPERS = new Set(['sudo', 'doas', 'command', 'exec', 'nohup', 'time', 'nice', 'caffeinate', 'rtk', 'builtin', 'stdbuf']);
// Wrapper options that take a separate value: `sudo -u root`, `doas -u root`,
// `nice -n 5`, `stdbuf -o L`.
const WRAPPER_OPTIONS_WITH_VALUE = {
  sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T']),
  doas: new Set(['-a', '-C', '-u']),
  nice: new Set(['-n']),
  stdbuf: new Set(['-i', '-o', '-e']),
};
// Reserved words that can open a simple command: `then git add -A` runs git.
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'esac', 'fi', 'done']);
const WATCH_WITH_VALUE = new Set(['-n', '--interval', '-q', '--equexit']);
const PARALLEL_WITH_VALUE = new Set(['-j', '--jobs', '-S', '--sshlogin', '-a', '--arg-file', '--colsep', '-d', '--delimiter', '-E', '-I', '--replace', '--results', '--joblog', '--timeout', '--delay', '-n', '--max-args', '-L', '--max-lines']);
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);
// A `case` arm pattern: `a)`, `a|b)`, `(a)`, `*)`.
const CASE_PATTERN = /^\(?[^()\s]*\)$/;
const TIMEOUT_WITH_VALUE = new Set(['-s', '--signal', '-k', '--kill-after']);
const RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);

// Turns raw tokens into commands: strips redirections and env assignments,
// unwraps wrappers, and recurses into `bash -c` and `eval` bodies.
function finish(rawTokens, depth, stdin) {
  const argv = [];
  const redirects = [];
  const env = {};
  for (let index = 0; index < rawTokens.length; index += 1) {
    const token = rawTokens[index];
    if (REDIRECT.test(token)) {
      const target = rawTokens[index + 1];
      if (target !== undefined && !token.endsWith('&') && !/^&\d*-?$/.test(target)) redirects.push({ op: token, target });
      index += 1;
      continue;
    }
    if (argv.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      const split = token.indexOf('=');
      env[token.slice(0, split)] = token.slice(split + 1);
      continue;
    }
    argv.push(token);
  }
  return unwrap({ argv, env, redirects, stdin }, depth);
}

function unwrap(command, depth) {
  const { argv, env } = command;
  if (argv.length === 0) return [command];
  const head = basename(argv[0]);
  if (KEYWORDS.has(argv[0])) return unwrap({ ...command, argv: argv.slice(1) }, depth);
  // `case "$x" in a) git add -A;; esac`: the first arm follows `in`, later
  // arms start with their pattern after `;;`.
  if (argv[0] === 'case') {
    const body = argv.indexOf('in');
    if (body === -1) return [command];
    const rest = argv.slice(body + 1);
    return unwrap({ ...command, argv: CASE_PATTERN.test(rest[0] ?? '') ? rest.slice(1) : rest }, depth);
  }
  if (CASE_PATTERN.test(argv[0]) && argv.length > 1) return unwrap({ ...command, argv: argv.slice(1) }, depth);
  if (head === 'rtk' && argv[1] === 'proxy') return unwrap({ ...command, argv: argv.slice(2) }, depth);
  if (head === 'timeout' || head === 'gtimeout') {
    let index = 1;
    while (index < argv.length && argv[index].startsWith('-')) index += TIMEOUT_WITH_VALUE.has(argv[index]) ? 2 : 1;
    // The duration comes next, then the command.
    return unwrap({ ...command, argv: argv.slice(index + 1) }, depth);
  }
  if (head === 'env') {
    let index = 1;
    while (index < argv.length) {
      if (argv[index] === '-u' || argv[index] === '-C' || argv[index] === '-S') index += 2;
      else if (argv[index].startsWith('-')) index += 1;
      else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[index])) {
        const split = argv[index].indexOf('=');
        env[argv[index].slice(0, split)] = argv[index].slice(split + 1);
        index += 1;
      } else break;
    }
    return unwrap({ ...command, argv: argv.slice(index), env }, depth);
  }
  if (WRAPPERS.has(head)) {
    const withValue = WRAPPER_OPTIONS_WITH_VALUE[head] ?? new Set();
    let index = 1;
    while (index < argv.length && argv[index].startsWith('-')) {
      if (argv[index] === '--') {
        index += 1;
        break;
      }
      index += withValue.has(argv[index]) ? 2 : 1;
    }
    return unwrap({ ...command, argv: argv.slice(index) }, depth);
  }
  // `watch` runs its arguments through `sh -c` unless given -x.
  if (head === 'watch') {
    let index = 1;
    while (index < argv.length && argv[index].startsWith('-')) index += WATCH_WITH_VALUE.has(argv[index]) ? 2 : 1;
    return [command, ...parseCommands(argv.slice(index).join(' '), depth + 1)];
  }
  // GNU parallel runs the command before `:::` once per argument, through a
  // shell, with the argument in place of `{}` or appended. The guard reads the
  // command once per argument of the first source (at most 20).
  if (head === 'parallel') {
    let index = 1;
    while (index < argv.length && argv[index].startsWith('-')) index += PARALLEL_WITH_VALUE.has(argv[index]) ? 2 : 1;
    const isSeparator = (token) => /^:{3,4}\+?$/.test(token);
    const end = argv.findIndex((token, position) => position >= index && isSeparator(token));
    const template = argv.slice(index, end === -1 ? argv.length : end);
    if (end === -1) return [command, ...parseCommands(template.join(' '), depth + 1)];
    const next = argv.findIndex((token, position) => position > end && isSeparator(token));
    const values = argv.slice(end + 1, next === -1 ? argv.length : next).slice(0, 20);
    const runs = (values.length > 0 ? values : ['']).map((value) => (template.some((token) => token.includes('{}')) ? template.map((token) => token.replaceAll('{}', value)) : [...template, value]).filter(Boolean).join(' '));
    return [command, ...runs.flatMap((line) => parseCommands(line, depth + 1))];
  }
  // `find <paths> -exec <command> {} ;` runs <command> on what it finds; the
  // guard reads `{}` as the paths find starts from.
  if (head === 'find') {
    const firstExpression = argv.findIndex((token, position) => position > 0 && (token.startsWith('-') || token === '(' || token === '!'));
    const roots = argv.slice(1, firstExpression === -1 ? argv.length : firstExpression);
    const starts = roots.length > 0 ? roots : ['.'];
    const executed = [];
    argv.forEach((token, position) => {
      if (!FIND_EXEC.has(token)) return;
      const stop = argv.findIndex((candidate, after) => after > position && (candidate === ';' || candidate === '+'));
      const template = argv.slice(position + 1, stop === -1 ? argv.length : stop);
      for (const start of starts) executed.push(...unwrap({ ...command, argv: template.flatMap((part) => (part === '{}' ? [start] : [part.split('{}').join(start)])) }, depth));
    });
    return [command, ...executed];
  }
  if (RUNNERS.has(head) || (head === 'pnpm' && argv[1] === 'dlx') || (head === 'npm' && argv[1] === 'exec')) {
    let index = head === 'pnpm' || head === 'npm' ? 2 : 1;
    while (index < argv.length && argv[index].startsWith('-')) index += 1;
    if (argv[index] === '--') index += 1;
    return unwrap({ ...command, argv: argv.slice(index) }, depth);
  }
  if (SHELLS.has(head)) {
    const flag = argv.findIndex((token, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(token));
    if (flag !== -1 && argv[flag + 1] !== undefined) return [command, ...parseCommands(argv[flag + 1], depth + 1)];
  }
  if (head === 'eval') return [command, ...parseCommands(argv.slice(1).join(' '), depth + 1)];
  if (head === 'xargs') {
    let index = 1;
    while (index < argv.length && argv[index].startsWith('-')) index += ['-I', '-n', '-P', '-L', '-d', '-E'].includes(argv[index]) ? 2 : 1;
    if (index < argv.length) return [command, ...unwrap({ ...command, argv: argv.slice(index) }, depth)];
  }
  return [command];
}

export function basename(path) {
  return String(path).replace(/\/+$/, '').split('/').pop();
}
