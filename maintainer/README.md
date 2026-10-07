# Maintainer evidence

These documents retain implementation measurements and revision-specific validation
records. They are separate from the public Mintlify documentation in `docs/`.

- [Independent security review scope](security-review.md): the remaining review task.
- [Security and receiving validation](security-validation.md): local regressions and their limits.
- [Relay memory measurements](relay-memory.md): encryption, hashing and two-pass receiving.
- [Room churn measurements](room-churn.md): mesh boundary, TURN and interrupted transfers.
- [Hosted CI evidence](hosted-ci.md): results for the recorded historical revision.

Machine-readable records remain in `validation/`. File paths in recorded evidence
describe the revision measured; moving source files does not extend that evidence
to a newer revision. Release operations and repository setup are in [RELEASING.md](../RELEASING.md).
