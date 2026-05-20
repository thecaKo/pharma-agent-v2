import { opendir, lstat } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

export type DatabaseCandidateType = "firebird" | "mysql" | "sqlserver";
export type DatabaseDiscoveryConfidence = "high" | "medium" | "low";
export type DatabasePathKind = "file" | "directory";

export interface DatabaseFileCandidate {
  path: string;
  type: DatabaseCandidateType;
  confidence: DatabaseDiscoveryConfidence;
}

export interface DatabaseSetupCandidateView extends DatabaseFileCandidate {
  index: number;
  supported: boolean;
  warning?: string;
  internal?: boolean;
}

export interface DatabaseFileDiscoveryResult {
  candidates: DatabaseFileCandidate[];
  scannedPaths: number;
  blockedPaths: number;
}

export interface DatabaseFileDiscoveryOptions {
  roots?: readonly string[];
}

export interface DatabasePathMetadata {
  path: string;
  kind: DatabasePathKind;
}

interface DiscoveryAccumulator {
  candidates: DatabaseFileCandidate[];
  scannedPaths: number;
  blockedPaths: number;
}

const confidenceRank: Record<DatabaseDiscoveryConfidence, number> = {
  high: 0,
  medium: 1,
  low: 2
};

const typeRank: Record<DatabaseCandidateType, number> = {
  firebird: 0,
  mysql: 1,
  sqlserver: 2
};

const setupSupportRank = {
  supported: 0,
  unsupported: 1
} as const;

const setupInternalRank = {
  external: 0,
  internal: 1
} as const;

const firebirdFileConfidence = new Map<string, DatabaseDiscoveryConfidence>([
  [".fdb", "high"],
  [".gdb", "medium"],
  [".fbk", "low"]
]);

const sqlServerFileConfidence = new Map<string, DatabaseDiscoveryConfidence>([
  [".mdf", "high"],
  [".ndf", "medium"],
  [".ldf", "low"]
]);

const mysqlFileConfidence = new Map<string, DatabaseDiscoveryConfidence>([
  [".ibd", "high"],
  [".myd", "medium"],
  [".myi", "medium"],
  [".frm", "low"]
]);

const mysqlDataDirectoryNames = new Set(["mysql-data", "mysql_data", "mysqldata", "mariadb-data", "mariadb_data"]);
const firebirdInternalFileNames = new Set(["security2.fdb", "security3.fdb", "security4.fdb"]);
const mysqlInternalFileNames = new Set(["ib_buffer_pool", "mysql.ibd"]);

const sqlServerUnsupportedWarning = "SQL Server discovery is visible, but onboarding support is not implemented.";
const firebirdInternalWarning = "Firebird security database detected; choose the pharmacy database instead.";
const mysqlInternalWarning = "MySQL internal/shared file detected; choose an application schema file instead.";

export async function discoverDatabaseFiles(
  options: DatabaseFileDiscoveryOptions = {}
): Promise<DatabaseFileDiscoveryResult> {
  const roots = resolveDatabaseDiscoveryRoots(options.roots);
  const accumulator: DiscoveryAccumulator = {
    candidates: [],
    scannedPaths: 0,
    blockedPaths: 0
  };

  for (const root of roots) {
    await scanPath(root, accumulator);
  }

  return {
    candidates: sortDatabaseFileCandidates(accumulator.candidates),
    scannedPaths: accumulator.scannedPaths,
    blockedPaths: accumulator.blockedPaths
  };
}

export function resolveDatabaseDiscoveryRoots(roots?: readonly string[]): string[] {
  if (roots !== undefined && roots.length > 0) {
    return uniqueSortedPaths(roots.map((root) => path.resolve(root)));
  }

  return defaultSystemScanRoots();
}

export function classifyDatabasePath(entry: DatabasePathMetadata): DatabaseFileCandidate | undefined {
  if (entry.kind === "directory") {
    return classifyDirectory(entry.path);
  }

  return classifyFile(entry.path);
}

export function compareDatabaseFileCandidates(
  left: DatabaseFileCandidate,
  right: DatabaseFileCandidate
): number {
  const confidenceComparison = confidenceRank[left.confidence] - confidenceRank[right.confidence];
  if (confidenceComparison !== 0) {
    return confidenceComparison;
  }

  const typeComparison = typeRank[left.type] - typeRank[right.type];
  if (typeComparison !== 0) {
    return typeComparison;
  }

  const leftPath = left.path.toLowerCase();
  const rightPath = right.path.toLowerCase();
  if (leftPath < rightPath) {
    return -1;
  }
  if (leftPath > rightPath) {
    return 1;
  }

  if (left.path < right.path) {
    return -1;
  }
  if (left.path > right.path) {
    return 1;
  }
  return 0;
}

export function sortDatabaseFileCandidates(
  candidates: readonly DatabaseFileCandidate[]
): DatabaseFileCandidate[] {
  return [...candidates].sort(compareDatabaseFileCandidates);
}

export function buildDatabaseSetupCandidateViews(
  candidates: readonly DatabaseFileCandidate[]
): DatabaseSetupCandidateView[] {
  return [...candidates]
    .map((candidate) => createDatabaseSetupCandidateView(candidate))
    .sort(compareDatabaseSetupCandidateViews)
    .map((candidate, index) => ({
      ...candidate,
      index: index + 1
    }));
}

export function compareDatabaseSetupCandidateViews(
  left: DatabaseSetupCandidateView,
  right: DatabaseSetupCandidateView
): number {
  const supportedComparison =
    (left.supported ? setupSupportRank.supported : setupSupportRank.unsupported) -
    (right.supported ? setupSupportRank.supported : setupSupportRank.unsupported);
  if (supportedComparison !== 0) {
    return supportedComparison;
  }

  const internalComparison =
    (left.internal ? setupInternalRank.internal : setupInternalRank.external) -
    (right.internal ? setupInternalRank.internal : setupInternalRank.external);
  if (internalComparison !== 0) {
    return internalComparison;
  }

  return compareDatabaseFileCandidates(left, right);
}

export function formatDatabaseSetupCandidateView(candidate: DatabaseSetupCandidateView): string {
  const status = candidate.supported ? (candidate.internal ? "internal" : "supported") : "unsupported";
  const warning = candidate.warning === undefined ? "" : ` - ${candidate.warning}`;
  return `${candidate.index}. ${candidate.path} [${candidate.type}, ${candidate.confidence}, ${status}]${warning}`;
}

function classifyFile(filePath: string): DatabaseFileCandidate | undefined {
  const extension = path.extname(filePath).toLowerCase();

  const firebirdConfidence = firebirdFileConfidence.get(extension);
  if (firebirdConfidence !== undefined) {
    return {
      path: filePath,
      type: "firebird",
      confidence: firebirdConfidence
    };
  }

  const sqlServerConfidence = sqlServerFileConfidence.get(extension);
  if (sqlServerConfidence !== undefined) {
    return {
      path: filePath,
      type: "sqlserver",
      confidence: sqlServerConfidence
    };
  }

  const mysqlConfidence = mysqlFileConfidence.get(extension) ?? classifyMySqlSharedDataFile(filePath);
  if (mysqlConfidence !== undefined) {
    return {
      path: filePath,
      type: "mysql",
      confidence: mysqlConfidence
    };
  }

  return undefined;
}

function createDatabaseSetupCandidateView(candidate: DatabaseFileCandidate): DatabaseSetupCandidateView {
  const internalWarning = detectInternalCandidateWarning(candidate);
  if (candidate.type === "sqlserver") {
    return {
      ...candidate,
      index: 0,
      supported: false,
      warning: sqlServerUnsupportedWarning
    };
  }

  return {
    ...candidate,
    index: 0,
    supported: true,
    warning: internalWarning,
    internal: internalWarning !== undefined
  };
}

async function scanPath(entryPath: string, accumulator: DiscoveryAccumulator): Promise<void> {
  let stats: Stats;
  try {
    stats = await lstat(entryPath);
  } catch {
    accumulator.blockedPaths += 1;
    return;
  }

  accumulator.scannedPaths += 1;

  const kind = stats.isDirectory() ? "directory" : stats.isFile() ? "file" : undefined;
  if (kind === undefined) {
    return;
  }

  const candidate = classifyDatabasePath({ path: entryPath, kind });
  if (candidate !== undefined) {
    accumulator.candidates.push(candidate);
  }

  if (kind === "directory") {
    await scanDirectory(entryPath, accumulator);
  }
}

async function scanDirectory(directoryPath: string, accumulator: DiscoveryAccumulator): Promise<void> {
  let directory;
  try {
    directory = await opendir(directoryPath);
  } catch {
    accumulator.blockedPaths += 1;
    return;
  }

  try {
    for await (const entry of directory) {
      await scanPath(path.join(directoryPath, entry.name), accumulator);
    }
  } catch {
    accumulator.blockedPaths += 1;
  }
}

function classifyDirectory(directoryPath: string): DatabaseFileCandidate | undefined {
  const segments = normalizedPathSegments(directoryPath);
  const directoryName = segments.at(-1);

  if (directoryName === undefined) {
    return undefined;
  }

  if (mysqlDataDirectoryNames.has(directoryName)) {
    return {
      path: directoryPath,
      type: "mysql",
      confidence: "medium"
    };
  }

  const hasMySqlAncestor = segments.slice(0, -1).some((segment) => segment.includes("mysql") || segment.includes("mariadb"));
  if (directoryName === "data" && hasMySqlAncestor) {
    return {
      path: directoryPath,
      type: "mysql",
      confidence: "medium"
    };
  }

  return undefined;
}

function defaultSystemScanRoots(): string[] {
  return uniqueSortedPaths([path.parse(process.cwd()).root]);
}

function classifyMySqlSharedDataFile(filePath: string): DatabaseDiscoveryConfidence | undefined {
  const fileName = path.basename(filePath).toLowerCase();

  if (/^ibdata\d+$/.test(fileName)) {
    return "medium";
  }

  if (/^ib_logfile\d+$/.test(fileName)) {
    return "low";
  }

  return undefined;
}

function detectInternalCandidateWarning(candidate: DatabaseFileCandidate): string | undefined {
  const fileName = path.basename(candidate.path).toLowerCase();

  if (candidate.type === "firebird" && firebirdInternalFileNames.has(fileName)) {
    return firebirdInternalWarning;
  }

  if (candidate.type === "mysql") {
    if (mysqlInternalFileNames.has(fileName)) {
      return mysqlInternalWarning;
    }

    if (/^ibdata\d+$/.test(fileName) || /^ib_logfile\d+$/.test(fileName)) {
      return mysqlInternalWarning;
    }
  }

  return undefined;
}

function uniqueSortedPaths(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort(comparePaths);
}

function normalizedPathSegments(value: string): string[] {
  return value
    .split(/[\\/]+/)
    .map((segment) => segment.trim().toLowerCase())
    .filter((segment) => segment.length > 0);
}

function comparePaths(left: string, right: string): number {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  if (normalizedLeft < normalizedRight) {
    return -1;
  }
  if (normalizedLeft > normalizedRight) {
    return 1;
  }
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
