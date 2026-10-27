# Security policy

The harness installs hooks that filter agent commands and protect its own files. A flaw can therefore let an agent bypass a protection in the repositories that use it.

## Reporting a vulnerability

Do not post details in a public issue. Use [GitHub private vulnerability reporting](https://github.com/looties-io/looties-harness/security/advisories/new) and include:

- the affected version or commit;
- the component (hook, installer, runtime, skill…);
- a minimal reproduction, ideally in a scratch repository;
- the observed and the expected effect.

We acknowledge reports as soon as possible and keep you informed of the analysis and the fix.

## Scope

In scope: bypasses of the guard hook, of review stamps or of the protection of harness files; an install that overwrites files without `--force`; unintended command execution; secrets leaking through hooks or the journal.

The guard hook is a safety net against mistakes by cooperative agents, not a sandbox against a hostile one. A bypass by a deliberately malicious agent is still worth reporting, but external permissions, branch protection and isolation remain necessary.
