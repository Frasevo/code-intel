# Security policy

This is an experimental developer tool. It does not claim a security audit or complete detection of sensitive content. Do not run it with elevated privileges. Only analyze repositories you are authorized to inspect.

Artifacts contain file names and hashes and may reveal confidential implementation details. Keep real snapshots, logs and integration profiles private. A GitHub repository being public does not authorize publishing its scanned outputs.

**Responsible reporting:** Do not publish exploit details or secrets in public issues. Contact maintainers privately through GitHub's "Report a vulnerability" feature **if enabled**; otherwise request a private contact channel from the repository owners without disclosing the vulnerability details.

No automated patch execution, shell evaluation of repository files, or external data transmission is implemented in CI-01. Report suspected traversal, symlink, import, or confidentiality issues.
