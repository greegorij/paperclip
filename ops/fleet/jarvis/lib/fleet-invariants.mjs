/**
 * Hard-coded Jarvis fleet invariants. Do not trust editable desired/fleet.json alone —
 * validate that overlays match these constants, and that live snapshots satisfy them.
 */
export const FLEET_INVARIANTS = Object.freeze({
  expectedLiveAgentCount: 30,
  portableAgentCount: 28,
  managedBuiltInCount: 2,
  requiredBuiltInKeys: Object.freeze(["summarizer", "reflection-coach"]),
});

export function assertDesiredFleetMatchesInvariants(fleet) {
  const errors = [];
  if (fleet?.expectedLiveAgentCount !== FLEET_INVARIANTS.expectedLiveAgentCount) {
    errors.push(
      `fleet.json expectedLiveAgentCount=${fleet?.expectedLiveAgentCount} != invariant ${FLEET_INVARIANTS.expectedLiveAgentCount}`,
    );
  }
  if (fleet?.portableAgentCount !== FLEET_INVARIANTS.portableAgentCount) {
    errors.push(
      `fleet.json portableAgentCount=${fleet?.portableAgentCount} != invariant ${FLEET_INVARIANTS.portableAgentCount}`,
    );
  }
  if (fleet?.managedBuiltInCount !== FLEET_INVARIANTS.managedBuiltInCount) {
    errors.push(
      `fleet.json managedBuiltInCount=${fleet?.managedBuiltInCount} != invariant ${FLEET_INVARIANTS.managedBuiltInCount}`,
    );
  }
  const sum =
    FLEET_INVARIANTS.portableAgentCount + FLEET_INVARIANTS.managedBuiltInCount;
  if (FLEET_INVARIANTS.expectedLiveAgentCount !== sum) {
    errors.push(
      `invariant arithmetic broken: ${FLEET_INVARIANTS.expectedLiveAgentCount} != ${FLEET_INVARIANTS.portableAgentCount}+${FLEET_INVARIANTS.managedBuiltInCount}`,
    );
  }
  if (FLEET_INVARIANTS.requiredBuiltInKeys.length !== FLEET_INVARIANTS.managedBuiltInCount) {
    errors.push("requiredBuiltInKeys length must equal managedBuiltInCount");
  }
  return { ok: errors.length === 0, errors };
}
