import { describe, expect, it } from "vitest";
import { parseCredentials } from "../../src/discovery/credential-parser.js";

describe("parseCredentials — connection-string (driver://user:pass@host:port/db)", () => {
  it("extrai driver/host/port/user/password/database de uma URL completa", () => {
    const out = parseCredentials("postgres://ro:s3cr3t@10.0.0.5:5433/linx");
    expect(out).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          driver: "postgresql",
          host: "10.0.0.5",
          port: 5433,
          user: "ro",
          password: "s3cr3t",
          database: "linx"
        })
      ])
    );
  });

  it("aplica porta default por driver quando ausente na URL", () => {
    const out = parseCredentials("mysql://app:pw@db.local/loja");
    expect(out[0]).toMatchObject({ driver: "mysql", host: "db.local", port: 3306, user: "app", database: "loja" });
  });

  it("normaliza aliases de driver (postgres→postgresql, mssql→sqlserver)", () => {
    expect(parseCredentials("mssql://sa:p@srv:1433/m")[0]).toMatchObject({ driver: "sqlserver" });
    expect(parseCredentials("firebird://sysdba:m@h/db")[0]).toMatchObject({ driver: "firebird", port: 3050 });
  });
});

describe("parseCredentials — connection-string (Server=...;Database=...;User Id=...;Password=...)", () => {
  it("parseia chave=valor separado por ponto-e-vírgula com aliases comuns", () => {
    const out = parseCredentials(
      "Server=192.168.0.10,1433;Database=ERP;User Id=leitor;Password=abc123;Driver={SQL Server}"
    );
    expect(out[0]).toMatchObject({
      driver: "sqlserver",
      host: "192.168.0.10",
      port: 1433,
      user: "leitor",
      password: "abc123",
      database: "ERP"
    });
  });
});

describe("parseCredentials — ini", () => {
  it("extrai de um arquivo ini com seção", () => {
    const content = [
      "[database]",
      "driver = mysql",
      "host = dbhost",
      "port = 3307",
      "user = svc",
      "password = pwd",
      "database = catalogo"
    ].join("\n");
    const out = parseCredentials(content);
    expect(out).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          driver: "mysql",
          host: "dbhost",
          port: 3307,
          user: "svc",
          password: "pwd",
          database: "catalogo"
        })
      ])
    );
  });
});

describe("parseCredentials — key=value plano", () => {
  it("extrai de pares key=value sem seção (aliases dbname/username/pwd)", () => {
    const content = [
      "DB_DRIVER=postgresql",
      "DB_HOST=pg.internal",
      "DB_PORT=5432",
      "DB_USERNAME=reader",
      "DB_PASSWORD=topsecret",
      "DB_NAME=vendas"
    ].join("\n");
    const out = parseCredentials(content);
    expect(out[0]).toMatchObject({
      driver: "postgresql",
      host: "pg.internal",
      port: 5432,
      user: "reader",
      password: "topsecret",
      database: "vendas"
    });
  });
});

describe("parseCredentials — validade mínima", () => {
  it("não produz candidato sem driver+host+user", () => {
    expect(parseCredentials("host = only-host\nport = 3306")).toEqual([]);
    expect(parseCredentials("driver=mysql\nuser=x")).toEqual([]); // falta host
    expect(parseCredentials("driver=mysql\nhost=h")).toEqual([]); // falta user
  });

  it("ignora conteúdo sem credenciais", () => {
    expect(parseCredentials("apenas um texto qualquer\nsem nada útil")).toEqual([]);
  });
});
