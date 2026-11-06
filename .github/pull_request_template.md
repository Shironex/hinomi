<!--
Title: conventional commit with a scope, for example `fix(server): keep the scan lock on retry`.
Pull requests are rebase-merged, so every commit lands on main as written.
-->

## Summary

<!-- What does this change, and why? Keep it short. -->

Closes #

<!-- A linked issue (or an agreeing discussion) is required. See CONTRIBUTING.md. -->

## Test plan

<!-- How did you check it? Commands run, cases covered, what a reviewer can try. -->

## Checklist

- [ ] An issue or discussion agreed on this change (linked above)
- [ ] `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` pass
- [ ] Commits are small, scoped conventional commits with no fixup or merge commits
- [ ] No secrets, real hostnames or IPs in code, fixtures or docs
- [ ] Docs updated if behavior changed
- [ ] No AI attribution lines in commits or this description

## Screenshots

<!-- For UI changes: before and after. Delete this section otherwise. -->
