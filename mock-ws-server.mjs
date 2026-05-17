import { WebSocketServer } from "ws";

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 8787 });

  const mapping = {
    mappingVersion: "mapping-v1",
    pollIntervalMs: 5000,
    batchSize: 500,
    incrementalQuery: `
      select *
      from products
      where updated_at > coalesce(?, '1900-01-01 00:00:00')
      order by updated_at
      limit ?
    `.trim(),
    cursorField: "updated_at",
    cursorType: "timestamp",
    fields: {
      sourceProductCode: "product_id",
      name: "description",
      barcode: "ean",
      price: "sale_price",
      stock: "quantity",
      active: "is_active",
      sourceUpdatedAt: "updated_at"
    }
  };

  wss.on("connection", (socket, request) => {
    console.log("connected", request.headers.authorization);

    socket.send(JSON.stringify({
      type: "connector.config",
      connectorId: "local-test-connector",
      customerId: "local-test-customer",
      mapping
    }));

    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString("utf8"));
      console.log("received:", JSON.stringify(msg, null, 2));

      if (msg.type === "product.batch") {
        socket.send(JSON.stringify({
          type: "batch.ack",
          batchId: msg.batch.batchId,
          accepted: true,
          acceptedRecordCount: msg.batch.records.length,
          rejectedRecordCount: 0,
          nextAction: "continue"
        }));
      }
    });
  });

  console.log("mock ws listening on ws://127.0.0.1:8787");