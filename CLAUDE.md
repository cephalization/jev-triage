# typeful-triage

Multiplayer GitHub issue triage dashboard: Vite+ (`vp`), React, shadcn/ui, Rocicorp Zero, Hono,
TypeSafe System One as the classifier.

Read `docs/BRIEF.md` before doing anything. Part 1 lists toolchain traps that will break the very
first `vp install` on this machine; Part 2 is the plan, data model, question design and milestones.

Standing rules:

- Apply the Part 1 install fixes right after `vp create`, before `vp install`.
- Use the `typesafe` skill (`typesafe@typesafe-ai` plugin) for any question or policy work; read
  the live docs it points at.
- The TypeSafe SDK and all secrets live only in `apps/api`. Never import it in `apps/web`.
- Write files in the formatter's style (double quotes), then run `vp check --fix` and `vp test`.
  Prefer whole-file rewrites over string patches against formatted code.
- Keep `decide()` and question builders pure and covered by canned-answer tests.
- One in-flight TypeSafe request per repo; log usage on every request.
