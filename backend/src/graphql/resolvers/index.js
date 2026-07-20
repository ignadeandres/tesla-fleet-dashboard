import { DateTimeScalar, JSONScalar } from "../scalars.js";
import { Query } from "./query.js";
import { Mutation } from "./mutation.js";
import { User, Vehicle, Trip } from "./types.js";

export const resolvers = {
  DateTime: DateTimeScalar,
  JSON: JSONScalar,
  Query,
  Mutation,
  User,
  Vehicle,
  Trip,
};
