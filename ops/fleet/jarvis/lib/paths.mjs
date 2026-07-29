import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const FLEET_ROOT = path.resolve(__dirname, "..");
export const PACKAGE_DIR = path.join(FLEET_ROOT, "package");
export const DESIRED_DIR = path.join(FLEET_ROOT, "desired");
export const FIXTURES_DIR = path.join(FLEET_ROOT, "tests", "fixtures");

export function resolveFleetPath(...parts) {
  return path.join(FLEET_ROOT, ...parts);
}
