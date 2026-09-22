# Training material

| Document | Who reads it | Language |
|---|---|---|
| [`admin.ckb.md`](admin.ckb.md) | the factory's admin | Kurdish Sorani |
| [`admin.en.md`](admin.en.md) | the admin, and whoever maintains the system | English |
| [`cards/sales.{ckb,ar,en}.md`](cards) | an employee on the *Sales* preset | all three |
| [`cards/warehouse.{ckb,ar,en}.md`](cards) | an employee on the *Warehouse* preset | all three |
| [`cards/accountant.{ckb,ar,en}.md`](cards) | the person on the *Accountant* preset | all three |

The quick cards are one page each, meant to be printed and left beside the device. Every button
and screen they name is quoted from the message catalogs in `packages/i18n/locales`, so a card
and the screen it describes use the same words (specification 1.6); when a term in the glossary
changes, the cards change with it.

The operations side — deploy, backup, restore, monitoring, incidents and the **go-live
checklist** — is in [`ops/runbook/README.md`](../../ops/runbook/README.md), with the restore
drills logged in [`ops/runbook/restore-drills.md`](../../ops/runbook/restore-drills.md).

The 30-minute training session per role (section 4.8) is delivered from these documents and
recorded as a screen video at handover; the recording is the client's, and is not kept in this
repository.
