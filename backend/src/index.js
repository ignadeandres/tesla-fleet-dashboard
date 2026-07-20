import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cookieParser from "cookie-parser";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express4";
import { resolvers } from "./graphql/resolvers/index.js";
import { buildContext } from "./demo/context.js";
import { teslaAuthRouter } from "./routes/teslaAuth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const typeDefs = fs.readFileSync(path.join(__dirname, "graphql/schema.graphql"), "utf-8");

const apollo = new ApolloServer({ typeDefs, resolvers });
await apollo.start();

const app = express();
app.use(cookieParser());

app.use(
  "/graphql",
  express.json(),
  expressMiddleware(apollo, {
    context: async ({ req, res }) => buildContext(req, res),
  })
);

app.use("/auth", teslaAuthRouter);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`[backend] listening on :${PORT}`));
