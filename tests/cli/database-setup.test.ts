import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildIncrementalReadTestQuery,
  buildSnapshotReadTestQuery,
  connectWithRetry,
  connectionDefaults,
  discoveryConnectionSource,
  formatCandidateSelectionTable,
  manualConnectionSource,
  parseDatabaseSetupArgs,
  promptForConnectionConfig,
  rankDatabaseColumns,
  rankDatabaseTables,
  runDatabaseSetup,
  runDatabaseSetupCli,
  selectManualDriver,
  selectSetupMode,
  type DatabaseSetupCliOptions,
  type DatabaseSetupPrompt,
  type DatabaseSetupSelection
} from "../../src/cli/database-setup.js";
import { buildDatabaseSetupCandidateViews } from "../../src/db/file-discovery.js";
import type { DatabaseColumn, DatabaseTable, SourceDatabaseAdapter } from "../../src/db/source-adapter.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("database setup CLI parser", () => {
  it("parses options and applies defaults", () => {
    expect(
      parseDatabaseSetupArgs([
        "--root",
        "/tmp/a",
        "--root",
        "/tmp/b",
        "--env-file",
        "/tmp/.env.local",
        "--artifact-file",
        "/tmp/onboarding.json",
        "--connector-token",
        "token-1",
        "--ws-url",
        "wss://central/ws",
        "--log-level",
        "debug",
        "--batch-size",
        "250",
        "--poll-interval-ms",
        "5000"
      ])
    ).toEqual({
      roots: ["/tmp/a", "/tmp/b"],
      envFilePath: "/tmp/.env.local",
      artifactFilePath: "/tmp/onboarding.json",
      connectorToken: "token-1",
      websocketUrl: "wss://central/ws",
      logLevel: "debug",
      batchSize: 250,
      pollIntervalMs: 5000
    });
  });

  it("rejects unknown options and documents usage with --help", () => {
    expect(() => parseDatabaseSetupArgs(["--unknown"])).toThrow("Unknown option: --unknown");
    expect(() => parseDatabaseSetupArgs(["--help"])).toThrow("Usage: database-setup");
    expect(() => parseDatabaseSetupArgs(["--root"])).toThrow("--root requires a value");
  });
});

describe("database setup helpers", () => {
  it("formats supported and internal candidates with warnings", () => {
    const table = formatCandidateSelectionTable([
      { path: "/db/PHARMACY.FDB", type: "firebird", confidence: "high" },
      { path: "/db/security3.fdb", type: "firebird", confidence: "high" }
    ]);

    expect(table).toContain("/db/PHARMACY.FDB [firebird, high, supported]");
    expect(table).toContain("/db/security3.fdb [firebird, high, internal]");
    expect(table).toContain("Firebird security database detected");
  });

  it("derives Firebird defaults from the selected local file", () => {
    const candidate = buildDatabaseSetupCandidateViews([
      { path: "/opt/pharmacy/PHARMACY.FDB", type: "firebird", confidence: "high" }
    ])[0];

    expect(connectionDefaults(discoveryConnectionSource(candidate))).toEqual({
      host: "127.0.0.1",
      port: 3050,
      databaseName: "/opt/pharmacy/PHARMACY.FDB",
      user: "SYSDBA",
      password: "masterkey"
    });
  });

  it("derives MySQL schema defaults from discovered candidate paths", () => {
    const candidate = buildDatabaseSetupCandidateViews([
      { path: "/var/lib/mysql/pharmacy/products.ibd", type: "mysql", confidence: "high" }
    ])[0];

    expect(connectionDefaults(discoveryConnectionSource(candidate)).databaseName).toBe("pharmacy");
  });

  it("derives an empty MySQL database default when the path has only generic segments", () => {
    const candidate = buildDatabaseSetupCandidateViews([
      { path: "/var/lib/mysql/data/mysql.ibd", type: "mysql", confidence: "high" }
    ])[0];

    expect(connectionDefaults(discoveryConnectionSource(candidate)).databaseName).toBe("");
  });

  it("uses manual MySQL defaults without a discovered candidate", () => {
    expect(connectionDefaults(manualConnectionSource("mysql"))).toEqual({
      host: "127.0.0.1",
      port: 3306,
      databaseName: "",
      user: "",
      password: ""
    });
  });

  it("uses manual Firebird defaults without a discovered candidate", () => {
    expect(connectionDefaults(manualConnectionSource("firebird"))).toEqual({
      host: "127.0.0.1",
      port: 3050,
      databaseName: "",
      user: "SYSDBA",
      password: "masterkey"
    });
  });

  it("honors environment-backed defaults when the env driver matches the selected driver", () => {
    const env = {
      DB_DRIVER: "mysql",
      DB_HOST: "db.example.com",
      DB_PORT: "3307",
      DB_NAME: "inventory",
      DB_USER: "app-user",
      DB_PASSWORD: "env-secret"
    };

    expect(connectionDefaults(manualConnectionSource("mysql"), env)).toEqual({
      host: "db.example.com",
      port: 3307,
      databaseName: "inventory",
      user: "app-user",
      password: "env-secret"
    });
  });

  it("ignores environment defaults when the env driver does not match the selected driver", () => {
    const env = {
      DB_DRIVER: "firebird",
      DB_HOST: "db.example.com",
      DB_PORT: "3307",
      DB_NAME: "/data/other.fdb",
      DB_USER: "app-user",
      DB_PASSWORD: "env-secret"
    };

    expect(connectionDefaults(manualConnectionSource("mysql"), env)).toEqual({
      host: "127.0.0.1",
      port: 3306,
      databaseName: "",
      user: "",
      password: ""
    });
  });

  it("prioritizes product-like tables first", () => {
    const ranked = rankDatabaseTables([{ name: "customers" }, { name: "inventory" }, { name: "products" }]);

    expect(ranked.map((table) => table.name)).toEqual(["products", "inventory", "customers"]);
  });

  it("prioritizes key product columns by field intent", () => {
    const columns: DatabaseColumn[] = [
      { name: "updated_at", dataType: "datetime" },
      { name: "description", dataType: "varchar" },
      { name: "ean", dataType: "varchar" },
      { name: "sale_price", dataType: "decimal" },
      { name: "is_active", dataType: "boolean" },
      { name: "quantity", dataType: "int" },
      { name: "product_id", dataType: "varchar" }
    ];

    expect(rankDatabaseColumns(columns, "sourceProductCode")[0]?.name).toBe("product_id");
    expect(rankDatabaseColumns(columns, "name")[0]?.name).toBe("description");
    expect(rankDatabaseColumns(columns, "price")[0]?.name).toBe("sale_price");
    expect(rankDatabaseColumns(columns, "stock")[0]?.name).toBe("quantity");
    expect(rankDatabaseColumns(columns, "barcode")[0]?.name).toBe("ean");
    expect(rankDatabaseColumns(columns, "active")[0]?.name).toBe("is_active");
    expect(rankDatabaseColumns(columns, "sourceUpdatedAt")[0]?.name).toBe("updated_at");
  });

  it("builds MySQL and Firebird read test queries with driver-compatible limits", () => {
    expect(buildIncrementalReadTestQuery("mysql", "products", "updated_at")).toBe(
      "select * from `products` where `updated_at` > ? order by `updated_at` limit ?"
    );
    expect(buildIncrementalReadTestQuery("firebird", "PRODUTOS", "UPDATED_AT")).toBe(
      'select * from "PRODUTOS" where "UPDATED_AT" > ? order by "UPDATED_AT" rows ?'
    );
  });

  it("builds MySQL and Firebird snapshot read test queries with driver-compatible pagination", () => {
    expect(buildSnapshotReadTestQuery("mysql", "products", "product_id")).toBe(
      "select * from `products` order by `product_id` limit ? offset ?"
    );
    expect(buildSnapshotReadTestQuery("firebird", "PRODUCTS", "PRODUCT_ID")).toBe(
      'select * from "PRODUCTS" order by "PRODUCT_ID" rows ? to ?'
    );
  });

  it("builds discovery and manual connection sources", () => {
    const candidate = buildDatabaseSetupCandidateViews([
      { path: "/db/PHARMACY.FDB", type: "firebird", confidence: "high" }
    ])[0];

    expect(discoveryConnectionSource(candidate)).toEqual({
      mode: "discovery",
      driver: "firebird",
      candidate
    });
    expect(manualConnectionSource("mysql")).toEqual({
      mode: "manual",
      driver: "mysql"
    });
  });

  it("allows manual setup selections without a discovered candidate", () => {
    const selection: DatabaseSetupSelection = {
      mode: "manual",
      config: {
        driver: "mysql",
        host: "127.0.0.1",
        port: 3306,
        name: "pharmacy",
        user: "readonly",
        password: "secret"
      },
      selectedTable: "products",
      cursorField: "updated_at",
      cursorType: "timestamp",
      incrementalQuery: "select * from products where updated_at > ? order by updated_at limit ?",
      batchSize: 500,
      mapping: {
        sourceProductCode: "product_id",
        name: "description",
        price: "sale_price",
        stock: "quantity"
      }
    };

    expect(selection.mode).toBe("manual");
    expect(selection.candidate).toBeUndefined();
  });
});

describe("database setup connection prompting", () => {
  it("rejects blank manual MySQL schema names before adapter creation", async () => {
    const output = createBufferedIo();
    const prompt = createPrompt({
      text: ["127.0.0.1", "3306", "   "]
    });
    const adapterFactory = vi.fn();

    await expect(
      promptForConnectionConfig({
        source: manualConnectionSource("mysql"),
        options: baseOptions(),
        prompt,
        env: {},
        io: output
      })
    ).rejects.toThrow("MySQL setup requires a database/schema name before connection.");

    expect(adapterFactory).not.toHaveBeenCalled();
  });

  it("rejects blank manual Firebird database paths before adapter creation", async () => {
    const output = createBufferedIo();
    const prompt = createPrompt({
      text: ["127.0.0.1", "3050", "   "]
    });
    const adapterFactory = vi.fn();

    await expect(
      promptForConnectionConfig({
        source: manualConnectionSource("firebird"),
        options: baseOptions(),
        prompt,
        env: {},
        io: output
      })
    ).rejects.toThrow("Firebird database path is required.");

    expect(adapterFactory).not.toHaveBeenCalled();
  });

  it("marks manual password prompts as secret", async () => {
    const output = createBufferedIo();
    const prompt = createPrompt({
      text: ["127.0.0.1", "3306", "pharmacy", "readonly", "manual-secret"]
    });

    await promptForConnectionConfig({
      source: manualConnectionSource("mysql"),
      options: baseOptions(),
      prompt,
      env: {},
      io: output
    });

    expect(prompt.textCalls.filter((call) => call.secret).map((call) => call.message)).toEqual([
      "Senha do banco"
    ]);
    expect(output.stdoutText()).not.toContain("manual-secret");
  });

  it("retries manual connection details for the same selected driver", async () => {
    const output = createBufferedIo();
    const prompt = createPrompt({
      text: ["127.0.0.1", "3306", "pharmacy", "readonly", "second-secret"],
      confirm: [true]
    });
    const firstAdapter = createAdapter({
      connect: vi.fn(async () => {
        throw new Error("Access denied for first-secret");
      })
    });
    const secondAdapter = createAdapter();
    const adapterFactory = vi.fn(() => (adapterFactory.mock.calls.length === 1 ? firstAdapter : secondAdapter));
    const source = manualConnectionSource("mysql");

    const result = await connectWithRetry({
      adapter: adapterFactory(),
      config: {
        driver: "mysql",
        host: "127.0.0.1",
        port: 3306,
        name: "pharmacy",
        user: "readonly",
        password: "first-secret"
      },
      options: baseOptions(),
      source,
      prompt,
      env: { CONNECTOR_TOKEN: "token-1", CONNECTOR_WS_URL: "wss://central/ws" },
      io: {
        ...output,
        createAdapter: () => adapterFactory()
      }
    });

    expect(result.config).toMatchObject({ driver: "mysql", password: "second-secret" });
    expect(adapterFactory).toHaveBeenCalledTimes(2);
    expect(firstAdapter.close).toHaveBeenCalled();
    expect(secondAdapter.connect).toHaveBeenCalledOnce();
    expect(output.stderrText()).not.toContain("first-secret");
  });
});

describe("database setup mode selection", () => {
  it("defaults manual connection as the first setup prompt", async () => {
    const prompt = createPrompt({});

    await expect(selectSetupMode(prompt, createBufferedIo())).resolves.toBe("manual");
    expect(prompt.events[0]).toBe("select:Selecione o modo de configuracao");
  });

  it("selects discovery mode when requested", async () => {
    const prompt = createPrompt({ select: ["discovery"] });

    await expect(selectSetupMode(prompt, createBufferedIo())).resolves.toBe("discovery");
  });

  it("defaults MySQL as the manual driver prompt", async () => {
    const prompt = createPrompt({});

    await expect(selectManualDriver(prompt)).resolves.toBe("mysql");
    expect(prompt.events[0]).toBe("select:Selecione o driver do banco");
  });

  it("selects Firebird when requested for manual setup", async () => {
    const prompt = createPrompt({ select: ["firebird"] });

    await expect(selectManualDriver(prompt)).resolves.toBe("firebird");
  });
});

describe("database setup runner", () => {
  it("returns a non-zero exit code when argument parsing fails", async () => {
    const output = createBufferedIo();

    await expect(runDatabaseSetupCli(["--unknown"], output)).resolves.toBe(1);
    expect(output.stderrText()).toContain("Unknown option: --unknown");
  });

  it("fails when discovery returns no local database candidates", async () => {
    await expect(
      runDatabaseSetup(baseOptions(), {
        ...createBufferedIo(),
        prompt: createPrompt({ select: discoverySelect() }),
        discoverDatabaseFiles: async () => ({
          candidates: [],
          scannedPaths: 0,
          blockedPaths: 0
        })
      })
    ).rejects.toThrow("Nenhum banco de dados local foi encontrado.");
  });

  it("completes manual MySQL setup using env-backed connection defaults", async () => {
    const prompt = createPrompt({
      select: manualSelect("mysql", [
        "products",
        "updated_at",
        "product_id",
        "description",
        "sale_price",
        "quantity",
        "",
        "",
        ""
      ])
    });
    const adapter = createAdapter();

    const result = await runDatabaseSetup(baseOptions(), {
      ...createBufferedIo(),
      prompt,
      env: {
        DB_DRIVER: "mysql",
        DB_HOST: "db.example.com",
        DB_PORT: "3307",
        DB_NAME: "inventory",
        DB_USER: "app-user",
        DB_PASSWORD: "env-db-secret",
        CONNECTOR_TOKEN: "token-1",
        CONNECTOR_WS_URL: "wss://central/ws"
      },
      discoverDatabaseFiles: vi.fn(),
      createAdapter: () => adapter,
      writeConnectorEnvFile: fakeWriteConnectorEnvFile,
      writeDatabaseSetupState: fakeWriteDatabaseSetupState
    });

    expect(result.config).toMatchObject({
      driver: "mysql",
      host: "db.example.com",
      port: 3307,
      name: "inventory",
      user: "app-user",
      password: "env-db-secret"
    });
    expect(prompt.textCalls[0]?.defaultValue).toBe("db.example.com");
    expect(prompt.textCalls[2]?.defaultValue).toBe("inventory");
  });

  it("does not call discoverDatabaseFiles in manual mode", async () => {
    const discoverDatabaseFiles = vi.fn(async () => ({
      candidates: [{ path: "/var/lib/mysql/pharmacy/products.ibd", type: "mysql", confidence: "high" }],
      scannedPaths: 1,
      blockedPaths: 0
    }));
    const prompt = createPrompt({
      select: manualSelect("mysql", ["products", "updated_at", "product_id", "description", "sale_price", "quantity", "", "", ""]),
      text: ["127.0.0.1", "3306", "pharmacy", "readonly", "db-secret"]
    });

    const result = await runDatabaseSetup(baseOptions(), {
      ...createBufferedIo(),
      prompt,
      env: { CONNECTOR_TOKEN: "token-1", CONNECTOR_WS_URL: "wss://central/ws" },
      discoverDatabaseFiles,
      createAdapter: () => createAdapter(),
      writeConnectorEnvFile: fakeWriteConnectorEnvFile,
      writeDatabaseSetupState: fakeWriteDatabaseSetupState
    });

    expect(discoverDatabaseFiles).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      mode: "manual",
      candidate: undefined,
      config: expect.objectContaining({ driver: "mysql", name: "pharmacy" })
    });
    expect(prompt.events[0]).toBe("select:Selecione o modo de configuracao");
    expect(prompt.events[1]).toBe("select:Selecione o driver do banco");
    expect(prompt.events[2]).toBe("text:Host do banco");
  });

  it("calls discoverDatabaseFiles only after discovery mode is selected", async () => {
    const discoverDatabaseFiles = vi.fn(async () => ({
      candidates: [{ path: "/var/lib/mysql/pharmacy/products.ibd", type: "mysql", confidence: "high" }],
      scannedPaths: 1,
      blockedPaths: 0
    }));
    const prompt = createPrompt({
      select: discoverySelect(["1", "products", "updated_at", "product_id", "description", "sale_price", "quantity", "", "", ""]),
      text: ["127.0.0.1", "3306", "pharmacy", "readonly", "db-secret"]
    });

    await runDatabaseSetup(baseOptions(), {
      ...createBufferedIo(),
      prompt,
      env: { CONNECTOR_TOKEN: "token-1", CONNECTOR_WS_URL: "wss://central/ws" },
      discoverDatabaseFiles,
      createAdapter: () => createAdapter(),
      writeConnectorEnvFile: fakeWriteConnectorEnvFile,
      writeDatabaseSetupState: fakeWriteDatabaseSetupState
    });

    expect(discoverDatabaseFiles).toHaveBeenCalledOnce();
    expect(prompt.events[0]).toBe("select:Selecione o modo de configuracao");
    expect(prompt.events[1]).toBe("select:Selecione o banco de dados");
  });

  it("reprompts when an invalid database candidate index is selected", async () => {
    const output = createBufferedIo();
    const prompt = createPrompt({
      select: discoverySelect(["99", "1", "products", "updated_at", "product_id", "description", "sale_price", "quantity", "", "", ""]),
      text: ["127.0.0.1", "3306", "pharmacy", "readonly", "db-secret"]
    });

    await runDatabaseSetup(baseOptions(), {
      ...output,
      prompt,
      env: { CONNECTOR_TOKEN: "token-1", CONNECTOR_WS_URL: "wss://central/ws" },
      discoverDatabaseFiles: async () => ({
        candidates: [{ path: "/var/lib/mysql/pharmacy/products.ibd", type: "mysql", confidence: "high" }],
        scannedPaths: 1,
        blockedPaths: 0
      }),
      createAdapter: () => createAdapter(),
      writeConnectorEnvFile: fakeWriteConnectorEnvFile,
      writeDatabaseSetupState: fakeWriteDatabaseSetupState
    });

    expect(prompt.events.filter((event) => event === "select:Selecione o banco de dados")).toHaveLength(2);
  });

  it("requires an explicit MySQL schema/database before connection", async () => {
    const output = createBufferedIo();
    const prompt = createPrompt({
      select: discoverySelect(["1"]),
      text: ["127.0.0.1", "3306", "   "]
    });
    const adapterFactory = vi.fn();

    await expect(
      runDatabaseSetup(baseOptions(), {
        ...output,
        prompt,
        discoverDatabaseFiles: async () => ({
          candidates: [{ path: "/var/lib/mysql/pharmacy/products.ibd", type: "mysql", confidence: "high" }],
          scannedPaths: 1,
          blockedPaths: 0
        }),
        createAdapter: adapterFactory,
        writeConnectorEnvFile: fakeWriteConnectorEnvFile,
        writeDatabaseSetupState: fakeWriteDatabaseSetupState
      })
    ).rejects.toThrow("MySQL setup requires a database/schema name before connection.");

    expect(adapterFactory).not.toHaveBeenCalled();
  });

  it("requires an explicit Firebird database path before connection", async () => {
    const output = createBufferedIo();
    const prompt = createPrompt({
      select: discoverySelect(["1"]),
      text: ["127.0.0.1", "3050", "   "]
    });
    const adapterFactory = vi.fn();

    await expect(
      runDatabaseSetup(baseOptions(), {
        ...output,
        prompt,
        discoverDatabaseFiles: async () => ({
          candidates: [{ path: "/db/PHARMACY.FDB", type: "firebird", confidence: "high" }],
          scannedPaths: 1,
          blockedPaths: 0
        }),
        createAdapter: adapterFactory,
        writeConnectorEnvFile: fakeWriteConnectorEnvFile,
        writeDatabaseSetupState: fakeWriteDatabaseSetupState
      })
    ).rejects.toThrow("Firebird database path is required.");

    expect(adapterFactory).not.toHaveBeenCalled();
  });

  it("supports retrying after a failed manual connection and continues with the replacement adapter", async () => {
    const output = createBufferedIo();
    const prompt = createPrompt({
      select: manualSelect("mysql", [
        "products",
        "updated_at",
        "product_id",
        "description",
        "sale_price",
        "quantity",
        "",
        "",
        "updated_at"
      ]),
      text: [
        "127.0.0.1",
        "3306",
        "pharmacy",
        "readonly",
        "first-secret",
        "127.0.0.1",
        "3306",
        "pharmacy",
        "readonly",
        "second-secret"
      ],
      confirm: [true]
    });
    const firstAdapter = createAdapter({
      connect: vi.fn(async () => {
        throw new Error("Access denied for first-secret");
      })
    });
    const secondAdapter = createAdapter();
    const adapterFactory = vi.fn(() => (adapterFactory.mock.calls.length === 1 ? firstAdapter : secondAdapter));

    await expect(
      runDatabaseSetup(baseOptions(), {
        ...output,
        prompt,
        env: { CONNECTOR_TOKEN: "token-1", CONNECTOR_WS_URL: "wss://central/ws" },
        discoverDatabaseFiles: vi.fn(),
        createAdapter: adapterFactory,
        writeConnectorEnvFile: fakeWriteConnectorEnvFile,
        writeDatabaseSetupState: fakeWriteDatabaseSetupState
      })
    ).resolves.toMatchObject({
      mode: "manual",
      config: expect.objectContaining({ driver: "mysql", password: "second-secret" })
    });

    expect(adapterFactory).toHaveBeenCalledTimes(2);
    expect(firstAdapter.close).toHaveBeenCalled();
    expect(secondAdapter.listTables).toHaveBeenCalledOnce();
    expect(output.stderrText()).not.toContain("first-secret");
  });

  it("supports retrying after a failed connection and continues with the replacement adapter", async () => {
    const output = createBufferedIo();
    const prompt = createPrompt({
      select: discoverySelect([
        "1",
        "products",
        "updated_at",
        "product_id",
        "description",
        "sale_price",
        "quantity",
        "",
        "",
        "updated_at"
      ]),
      text: [
        "127.0.0.1",
        "3050",
        "/db/PHARMACY.FDB",
        "readonly",
        "first-secret",
        "127.0.0.1",
        "3050",
        "/db/PHARMACY.FDB",
        "readonly",
        "second-secret"
      ],
      confirm: [true]
    });
    const firstAdapter = createAdapter({
      connect: vi.fn(async () => {
        throw new Error("Access denied for first-secret");
      })
    });
    const secondAdapter = createAdapter();
    const adapterFactory = vi.fn(() => (adapterFactory.mock.calls.length === 1 ? firstAdapter : secondAdapter));

    await expect(
      runDatabaseSetup(baseOptions(), {
        ...output,
        prompt,
        env: { CONNECTOR_TOKEN: "token-1", CONNECTOR_WS_URL: "wss://central/ws" },
        discoverDatabaseFiles: async () => ({
          candidates: [{ path: "/db/PHARMACY.FDB", type: "firebird", confidence: "high" }],
          scannedPaths: 1,
          blockedPaths: 0
        }),
        createAdapter: adapterFactory,
        writeConnectorEnvFile: fakeWriteConnectorEnvFile,
        writeDatabaseSetupState: fakeWriteDatabaseSetupState
      })
    ).resolves.toMatchObject({
      config: expect.objectContaining({ password: "second-secret" })
    });

    expect(adapterFactory).toHaveBeenCalledTimes(2);
    expect(firstAdapter.close).toHaveBeenCalled();
    expect(secondAdapter.listTables).toHaveBeenCalledOnce();
    expect(secondAdapter.queryChanges).toHaveBeenCalledOnce();
    expect(output.stderrText()).not.toContain("first-secret");
  });

  it("prompts for cursor type when the selected column type cannot be inferred", async () => {
    const prompt = createPrompt({
      select: discoverySelect(["1", "products", "custom_cursor", "number", "product_id", "description", "sale_price", "quantity", "", "", ""]),
      text: ["127.0.0.1", "3306", "pharmacy", "readonly", "db-secret"]
    });
    const adapter = createAdapter({
      listColumns: vi.fn(async () => [
        { name: "product_id", dataType: "varchar" },
        { name: "description", dataType: "varchar" },
        { name: "sale_price", dataType: "decimal" },
        { name: "quantity", dataType: "int" },
        { name: "custom_cursor", dataType: "blob" }
      ])
    });

    const result = await runDatabaseSetup(baseOptions(), {
      ...createBufferedIo(),
      prompt,
      env: { CONNECTOR_TOKEN: "token-1", CONNECTOR_WS_URL: "wss://central/ws" },
      discoverDatabaseFiles: async () => ({
        candidates: [{ path: "/var/lib/mysql/pharmacy/products.ibd", type: "mysql", confidence: "high" }],
        scannedPaths: 1,
        blockedPaths: 0
      }),
      createAdapter: () => adapter,
      writeConnectorEnvFile: fakeWriteConnectorEnvFile,
      writeDatabaseSetupState: fakeWriteDatabaseSetupState
    });

    expect(result.cursorType).toBe("number");
    expect(prompt.events).toContain("select:Selecione o tipo do cursor");
  });

  it("uses MySQL-compatible read test SQL and parameters", async () => {
    const prompt = createPrompt({
      select: discoverySelect([
        "1",
        "products",
        "updated_at",
        "product_id",
        "description",
        "sale_price",
        "quantity",
        "ean",
        "is_active",
        "updated_at"
      ]),
      text: ["127.0.0.1", "3306", "pharmacy", "readonly", "db-secret"]
    });
    const adapter = createAdapter({
      listColumns: vi.fn(async () => [
        { name: "product_id", dataType: "varchar" },
        { name: "description", dataType: "varchar" },
        { name: "sale_price", dataType: "decimal" },
        { name: "quantity", dataType: "int" },
        { name: "ean", dataType: "varchar" },
        { name: "is_active", dataType: "boolean" },
        { name: "updated_at", dataType: "datetime" }
      ])
    });

    await runDatabaseSetup(baseOptions(), {
      ...createBufferedIo(),
      prompt,
      env: { CONNECTOR_TOKEN: "token-1", CONNECTOR_WS_URL: "wss://central/ws" },
      discoverDatabaseFiles: async () => ({
        candidates: [{ path: "/var/lib/mysql/pharmacy/products.ibd", type: "mysql", confidence: "high" }],
        scannedPaths: 1,
        blockedPaths: 0
      }),
      createAdapter: () => adapter,
      writeConnectorEnvFile: fakeWriteConnectorEnvFile,
      writeDatabaseSetupState: fakeWriteDatabaseSetupState
    });

    expect(adapter.queryChanges).toHaveBeenCalledWith({
      sql: "select * from `products` where `updated_at` > ? order by `updated_at` limit ?",
      cursor: "1970-01-01T00:00:00.000Z",
      limit: 500
    });
  });

  it("uses Firebird-compatible read test SQL for manual setup", async () => {
    const prompt = createPrompt({
      select: manualSelect("firebird", [
        "PRODUTOS",
        "SEQ",
        "number",
        "CODIGO",
        "DESCRICAO",
        "PRECO",
        "ESTOQUE",
        "",
        "",
        ""
      ]),
      text: ["127.0.0.1", "3050", "/db/PHARMACY.FDB", "SYSDBA", "masterkey"]
    });
    const adapter = createAdapter({
      listTables: vi.fn(async () => [{ name: "PRODUTOS" }]),
      listColumns: vi.fn(async () => [
        { name: "CODIGO", dataType: "varchar" },
        { name: "DESCRICAO", dataType: "varchar" },
        { name: "PRECO", dataType: "decimal" },
        { name: "ESTOQUE", dataType: "int" },
        { name: "SEQ", dataType: "varchar" }
      ])
    });

    await runDatabaseSetup(baseOptions(), {
      ...createBufferedIo(),
      prompt,
      env: { CONNECTOR_TOKEN: "token-1", CONNECTOR_WS_URL: "wss://central/ws" },
      discoverDatabaseFiles: vi.fn(),
      createAdapter: () => adapter,
      writeConnectorEnvFile: fakeWriteConnectorEnvFile,
      writeDatabaseSetupState: fakeWriteDatabaseSetupState
    });

    expect(adapter.queryChanges).toHaveBeenCalledWith({
      sql: 'select * from "PRODUTOS" where "SEQ" > ? order by "SEQ" rows ?',
      cursor: 0,
      limit: 500
    });
    expect(prompt.events[1]).toBe("select:Selecione o driver do banco");
  });

  it("uses Firebird-compatible read test SQL and parameters", async () => {
    const prompt = createPrompt({
      select: discoverySelect([
        "1",
        "PRODUTOS",
        "SEQ",
        "number",
        "CODIGO",
        "DESCRICAO",
        "PRECO",
        "ESTOQUE",
        "",
        "",
        ""
      ]),
      text: ["127.0.0.1", "3050", "/db/PHARMACY.FDB", "SYSDBA", "masterkey"]
    });
    const adapter = createAdapter({
      listTables: vi.fn(async () => [{ name: "PRODUTOS" }]),
      listColumns: vi.fn(async () => [
        { name: "CODIGO", dataType: "varchar" },
        { name: "DESCRICAO", dataType: "varchar" },
        { name: "PRECO", dataType: "decimal" },
        { name: "ESTOQUE", dataType: "int" },
        { name: "SEQ", dataType: "varchar" }
      ])
    });

    await runDatabaseSetup(baseOptions(), {
      ...createBufferedIo(),
      prompt,
      env: { CONNECTOR_TOKEN: "token-1", CONNECTOR_WS_URL: "wss://central/ws" },
      discoverDatabaseFiles: async () => ({
        candidates: [{ path: "/db/PHARMACY.FDB", type: "firebird", confidence: "high" }],
        scannedPaths: 1,
        blockedPaths: 0
      }),
      createAdapter: () => adapter,
      writeConnectorEnvFile: fakeWriteConnectorEnvFile,
      writeDatabaseSetupState: fakeWriteDatabaseSetupState
    });

    expect(adapter.queryChanges).toHaveBeenCalledWith({
      sql: 'select * from "PRODUTOS" where "SEQ" > ? order by "SEQ" rows ?',
      cursor: 0,
      limit: 500
    });
  });

  it("marks password/token prompts as secret and never prints their values", async () => {
    const dir = await tempDir("database-setup-secret-");
    const envFilePath = join(dir, ".env");
    const artifactFilePath = join(dir, "onboarding.json");
    const output = createBufferedIo();
    const prompt = createPrompt({
      select: discoverySelect(["1", "products", "updated_at", "product_id", "description", "sale_price", "quantity", "", "", ""]),
      text: ["127.0.0.1", "3306", "pharmacy", "readonly", "db-secret", "connector-secret", "wss://central/ws"]
    });

    await runDatabaseSetup(baseOptions({ envFilePath, artifactFilePath }), {
      ...output,
      prompt,
      discoverDatabaseFiles: async () => ({
        candidates: [{ path: "/var/lib/mysql/pharmacy/products.ibd", type: "mysql", confidence: "high" }],
        scannedPaths: 1,
        blockedPaths: 0
      }),
      createAdapter: () => createAdapter()
    });

    expect(prompt.textCalls.filter((call) => call.secret).map((call) => call.message)).toEqual([
      "Senha do banco",
      "Token do conector"
    ]);
    expect(output.stdoutText()).not.toContain("db-secret");
    expect(output.stdoutText()).not.toContain("connector-secret");
    expect(output.stderrText()).not.toContain("db-secret");
    expect(output.stderrText()).not.toContain("connector-secret");
  });

  it("marks manual password/token prompts as secret and never prints their values", async () => {
    const dir = await tempDir("database-setup-manual-secret-");
    const envFilePath = join(dir, ".env");
    const artifactFilePath = join(dir, "onboarding.json");
    const output = createBufferedIo();
    const prompt = createPrompt({
      select: manualSelect("mysql", ["products", "updated_at", "product_id", "description", "sale_price", "quantity", "", "", ""]),
      text: ["127.0.0.1", "3306", "pharmacy", "readonly", "db-secret", "connector-secret", "wss://central/ws"]
    });

    await runDatabaseSetup(baseOptions({ envFilePath, artifactFilePath }), {
      ...output,
      prompt,
      discoverDatabaseFiles: vi.fn(),
      createAdapter: () => createAdapter()
    });

    const artifact = await readFile(artifactFilePath, "utf8");
    expect(prompt.textCalls.filter((call) => call.secret).map((call) => call.message)).toEqual([
      "Senha do banco",
      "Token do conector"
    ]);
    expect(output.stdoutText()).not.toContain("db-secret");
    expect(output.stdoutText()).not.toContain("connector-secret");
    expect(output.stderrText()).not.toContain("db-secret");
    expect(output.stderrText()).not.toContain("connector-secret");
    expect(artifact).not.toContain("db-secret");
    expect(artifact).not.toContain("connector-secret");
  });
});

describe("database setup persistence integration", () => {
  it("writes env and onboarding artifacts for a mocked manual MySQL setup", async () => {
    const dir = await tempDir("database-setup-manual-mysql-");
    const envFilePath = join(dir, ".env");
    const artifactFilePath = join(dir, "onboarding.json");
    const discoverDatabaseFiles = vi.fn();
    const prompt = createPrompt({
      select: manualSelect("mysql", [
        "products",
        "updated_at",
        "product_id",
        "description",
        "sale_price",
        "quantity",
        "ean",
        "is_active",
        "updated_at"
      ]),
      text: ["127.0.0.1", "3306", "pharmacy", "readonly", "db-secret"]
    });

    const result = await runDatabaseSetup(
      baseOptions({
        envFilePath,
        artifactFilePath,
        connectorToken: "connector-token",
        websocketUrl: "wss://central-platform/connectors/ws"
      }),
      {
        ...createBufferedIo(),
        prompt,
        discoverDatabaseFiles,
        createAdapter: () =>
          createAdapter({
            listColumns: vi.fn(async () => [
              { name: "product_id", dataType: "varchar" },
              { name: "description", dataType: "varchar" },
              { name: "sale_price", dataType: "decimal" },
              { name: "quantity", dataType: "int" },
              { name: "ean", dataType: "varchar" },
              { name: "is_active", dataType: "boolean" },
              { name: "updated_at", dataType: "datetime" }
            ])
          })
      }
    );

    expect(discoverDatabaseFiles).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      mode: "manual",
      candidate: undefined,
      selectedTable: "products",
      cursorField: "updated_at",
      cursorType: "timestamp",
      batchSize: 500,
      mapping: {
        sourceProductCode: "product_id",
        name: "description",
        price: "sale_price",
        stock: "quantity",
        barcode: "ean",
        active: "is_active",
        sourceUpdatedAt: "updated_at"
      }
    });
    expect(result.incrementalQuery).toContain("updated_at");

    await expect(readFile(envFilePath, "utf8")).resolves.toContain("DB_DRIVER=mysql\n");
    await expect(readFile(envFilePath, "utf8")).resolves.toContain("CONNECTOR_TOKEN=connector-token\n");
    const artifact = await readFile(artifactFilePath, "utf8");
    expect(artifact).toContain('"driver": "mysql"');
    expect(artifact).toContain('"selectedProductTable": "products"');
    expect(artifact).not.toContain("db-secret");
    expect(artifact).not.toContain("connector-token");
  });

  it("writes env and onboarding artifacts for a mocked manual Firebird setup", async () => {
    const dir = await tempDir("database-setup-manual-firebird-");
    const envFilePath = join(dir, ".env");
    const artifactFilePath = join(dir, "onboarding.json");
    const discoverDatabaseFiles = vi.fn();
    const prompt = createPrompt({
      select: manualSelect("firebird", [
        "PRODUTOS",
        "DATA_ATUALIZACAO",
        "CODIGO",
        "DESCRICAO",
        "PRECO",
        "ESTOQUE",
        "",
        "",
        ""
      ]),
      text: ["127.0.0.1", "3050", "/data/PHARMACY.FDB", "SYSDBA", "firebird-secret"]
    });

    const result = await runDatabaseSetup(
      baseOptions({
        envFilePath,
        artifactFilePath,
        connectorToken: "connector-token",
        websocketUrl: "wss://central-platform/connectors/ws"
      }),
      {
        ...createBufferedIo(),
        prompt,
        discoverDatabaseFiles,
        createAdapter: () =>
          createAdapter({
            listTables: vi.fn(async () => [{ name: "PRODUTOS" }]),
            listColumns: vi.fn(async () => [
              { name: "CODIGO", dataType: "varchar" },
              { name: "DESCRICAO", dataType: "varchar" },
              { name: "PRECO", dataType: "decimal" },
              { name: "ESTOQUE", dataType: "int" },
              { name: "DATA_ATUALIZACAO", dataType: "timestamp" }
            ])
          })
      }
    );

    expect(discoverDatabaseFiles).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      mode: "manual",
      candidate: undefined,
      config: expect.objectContaining({
        driver: "firebird",
        name: "/data/PHARMACY.FDB",
        user: "SYSDBA"
      })
    });

    await expect(readFile(envFilePath, "utf8")).resolves.toContain("DB_DRIVER=firebird\n");
    await expect(readFile(envFilePath, "utf8")).resolves.toContain("DB_NAME=/data/PHARMACY.FDB\n");
    await expect(readFile(envFilePath, "utf8")).resolves.toContain("DB_PASSWORD=firebird-secret\n");
    const artifact = await readFile(artifactFilePath, "utf8");
    expect(artifact).toContain('"driver": "firebird"');
    expect(artifact).toContain('"cursorField": "DATA_ATUALIZACAO"');
    expect(artifact).not.toContain("firebird-secret");
    expect(artifact).not.toContain("connector-token");
  });

  it("writes env and onboarding artifacts for a mocked discovery Firebird setup", async () => {
    const dir = await tempDir("database-setup-firebird-");
    const envFilePath = join(dir, ".env");
    const artifactFilePath = join(dir, "onboarding.json");
    const prompt = createPrompt({
      select: discoverySelect(["1", "PRODUTOS", "DATA_ATUALIZACAO", "CODIGO", "DESCRICAO", "PRECO", "ESTOQUE", "", "", ""]),
      text: ["127.0.0.1", "3050", "/data/PHARMACY.FDB", "SYSDBA", "masterkey"]
    });

    const result = await runDatabaseSetup(
      baseOptions({
        envFilePath,
        artifactFilePath,
        connectorToken: "connector-token",
        websocketUrl: "wss://central-platform/connectors/ws"
      }),
      {
        ...createBufferedIo(),
        prompt,
        discoverDatabaseFiles: async () => ({
          candidates: [{ path: "/data/PHARMACY.FDB", type: "firebird", confidence: "high" }],
          scannedPaths: 1,
          blockedPaths: 0
        }),
        createAdapter: () =>
          createAdapter({
            listTables: vi.fn(async () => [{ name: "PRODUTOS" }]),
            listColumns: vi.fn(async () => [
              { name: "CODIGO", dataType: "varchar" },
              { name: "DESCRICAO", dataType: "varchar" },
              { name: "PRECO", dataType: "decimal" },
              { name: "ESTOQUE", dataType: "int" },
              { name: "DATA_ATUALIZACAO", dataType: "timestamp" }
            ])
          })
      }
    );

    expect(result).toMatchObject({
      mode: "discovery",
      candidate: expect.objectContaining({ type: "firebird", supported: true })
    });

    await expect(readFile(envFilePath, "utf8")).resolves.toContain("DB_DRIVER=firebird\n");
    await expect(readFile(envFilePath, "utf8")).resolves.toContain("DB_NAME=/data/PHARMACY.FDB\n");
    const artifact = await readFile(artifactFilePath, "utf8");
    expect(artifact).toContain('"driver": "firebird"');
    expect(artifact).toContain('"cursorField": "DATA_ATUALIZACAO"');
    expect(artifact).not.toContain("masterkey");
  });

  it("fails non-zero and does not write credentials when discovery setup aborts on connection failure", async () => {
    const dir = await tempDir("database-setup-fail-");
    const envFilePath = join(dir, ".env");
    const artifactFilePath = join(dir, "onboarding.json");
    const output = createBufferedIo();
    const prompt = createPrompt({
      select: discoverySelect(["1"]),
      text: ["127.0.0.1", "3306", "pharmacy", "readonly", "db-secret"],
      confirm: [false]
    });

    await expect(
      runDatabaseSetupCli(
        [
          "--env-file",
          envFilePath,
          "--artifact-file",
          artifactFilePath,
          "--connector-token",
          "connector-token",
          "--ws-url",
          "wss://central-platform/connectors/ws"
        ],
        {
          ...output,
          prompt,
          discoverDatabaseFiles: async () => ({
            candidates: [{ path: "/var/lib/mysql/pharmacy/products.ibd", type: "mysql", confidence: "high" }],
            scannedPaths: 1,
            blockedPaths: 0
          }),
          createAdapter: () =>
            createAdapter({
              connect: vi.fn(async () => {
                throw new Error("Access denied for db-secret");
              })
            })
        }
      )
    ).resolves.toBe(1);

    await expect(access(envFilePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(artifactFilePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(output.stderrText()).not.toContain("db-secret");
    expect(output.stderrText()).toContain("Access denied");
  });

  it("fails non-zero and does not write credentials when manual setup aborts on connection failure", async () => {
    const dir = await tempDir("database-setup-manual-fail-");
    const envFilePath = join(dir, ".env");
    const artifactFilePath = join(dir, "onboarding.json");
    const output = createBufferedIo();
    const prompt = createPrompt({
      select: manualSelect("mysql", []),
      text: ["127.0.0.1", "3306", "pharmacy", "readonly", "db-secret"],
      confirm: [false]
    });

    await expect(
      runDatabaseSetupCli(
        [
          "--env-file",
          envFilePath,
          "--artifact-file",
          artifactFilePath,
          "--connector-token",
          "connector-token",
          "--ws-url",
          "wss://central-platform/connectors/ws"
        ],
        {
          ...output,
          prompt,
          discoverDatabaseFiles: vi.fn(),
          createAdapter: () =>
            createAdapter({
              connect: vi.fn(async () => {
                throw new Error("Access denied for db-secret");
              })
            })
        }
      )
    ).resolves.toBe(1);

    await expect(access(envFilePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(artifactFilePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(output.stderrText()).not.toContain("db-secret");
    expect(output.stderrText()).toContain("Access denied");
  });
});

function discoverySelect(selections: string[] = []): string[] {
  return ["discovery", ...selections];
}

function manualSelect(driver: "mysql" | "firebird", selections: string[]): string[] {
  return ["manual", driver, ...selections];
}

function baseOptions(overrides: Partial<DatabaseSetupCliOptions> = {}): DatabaseSetupCliOptions {
  return {
    envFilePath: join(process.cwd(), ".env.test"),
    artifactFilePath: join(process.cwd(), ".database-setup.test.json"),
    logLevel: "info",
    batchSize: 500,
    pollIntervalMs: 10_000,
    ...overrides
  };
}

function createBufferedIo(): {
  stdout: { write: (chunk: string | Uint8Array) => boolean };
  stderr: { write: (chunk: string | Uint8Array) => boolean };
  stdoutText: () => string;
  stderrText: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write: (chunk) => {
        stdout += chunk.toString();
        return true;
      }
    },
    stderr: {
      write: (chunk) => {
        stderr += chunk.toString();
        return true;
      }
    },
    stdoutText: () => stdout,
    stderrText: () => stderr
  };
}

function createPrompt(input: {
  text?: string[];
  select?: string[];
  confirm?: boolean[];
}): DatabaseSetupPrompt & {
  events: string[];
  textCalls: Array<{ message: string; defaultValue?: string; secret?: boolean }>;
} {
  const text = [...(input.text ?? [])];
  const select = [...(input.select ?? [])];
  const confirm = [...(input.confirm ?? [])];
  const events: string[] = [];
  const textCalls: Array<{ message: string; defaultValue?: string; secret?: boolean }> = [];

  return {
    events,
    textCalls,
    text: async ({ message, defaultValue, secret }) => {
      events.push(`text:${message}`);
      textCalls.push({ message, defaultValue, secret });
      const next = text.shift();
      return next === undefined ? defaultValue ?? "" : next;
    },
    select: async ({ message, defaultValue }) => {
      events.push(`select:${message}`);
      const next = select.shift();
      return next === undefined ? defaultValue ?? "" : next;
    },
    confirm: async ({ message, defaultValue }) => {
      events.push(`confirm:${message}`);
      const next = confirm.shift();
      return next === undefined ? defaultValue ?? false : next;
    }
  };
}

function createAdapter(overrides: Partial<SourceDatabaseAdapter> = {}): SourceDatabaseAdapter {
  const tables: DatabaseTable[] = [{ name: "products" }];
  const columns: DatabaseColumn[] = [
    { name: "product_id", dataType: "varchar" },
    { name: "description", dataType: "varchar" },
    { name: "sale_price", dataType: "decimal" },
    { name: "quantity", dataType: "int" },
    { name: "updated_at", dataType: "timestamp" }
  ];

  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    listTables: vi.fn(async () => tables),
    listColumns: vi.fn(async () => columns),
    queryChanges: vi.fn(async () => [{ product_id: "P-001" }]),
    querySnapshotPage: vi.fn(async () => []),
    ...overrides
  };
}

async function fakeWriteConnectorEnvFile(input: { envFilePath: string }) {
  return {
    envFilePath: input.envFilePath,
    created: true,
    updatedKeys: [] as never[]
  };
}

async function fakeWriteDatabaseSetupState() {
  return {
    version: "1" as const,
    createdAt: "2026-05-18T12:00:00.000Z",
    driver: "mysql" as const,
    databaseName: "pharmacy",
    selectedProductTable: "products",
    cursorField: "updated_at",
    cursorType: "timestamp" as const,
    incrementalQuery: "select * from products where updated_at > ? order by updated_at limit ?",
    batchSize: 500,
    fields: {
      sourceProductCode: "product_id",
      name: "description",
      price: "sale_price",
      stock: "quantity"
    }
  };
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
