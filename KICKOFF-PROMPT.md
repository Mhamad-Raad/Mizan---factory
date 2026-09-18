# Kickoff prompt for Iteration 0 (paste into the agent, opened in this folder)

You are the implementation agent for Mizan, a single-factory materials, orders and supplier-accounting web system. Read `CLAUDE.md` first; it holds the rules for every session. Then read `iterations/I0-foundation.md` — it lists which sections of `spec/mizan-factory-system-spec-v1.2.md` to read, in which order, and exactly what to build. The full specification is the source of truth; the files in `spec/` are the same text split by deliverable.

Build Iteration 0 only, following the working order and checkpoints in the brief. Initialise the repository structure (API, web, shared packages), the CI pipeline, the database migrations for the I0 tables, the permission package, the money/ledger/text/i18n kernels with their tests, the I0 API endpoints with the permission-matrix test, and the I0 screens with the tokens for both themes.

The palette system's component library is available at <PATH OR PACKAGE NAME> — reuse it as the specification requires (section 2.10.11). Database and secrets are configured through `.env` (see `.env.example`).

Do not ask questions in chat: decide from the specification's assumptions and defaults, record decisions in `docs/DECISIONS.md`, blockers in `docs/QUESTIONS.md`, and keep `docs/PROGRESS.md` current. Stop at checkpoint D (identity review) and report; I will review on a phone before you continue to checkpoint E.

Start by writing the plan for checkpoint A into `docs/PROGRESS.md`, then begin.
