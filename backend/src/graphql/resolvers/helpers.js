import { GraphQLError } from "graphql";
import { getVehicleById } from "../../db/queries/vehicles.js";

export function requireUser(ctx) {
  if (!ctx.user) throw new GraphQLError("Not authenticated", { extensions: { code: "UNAUTHENTICATED" } });
  return ctx.user;
}

// Throws NOT_FOUND rather than FORBIDDEN for vehicles owned by someone else,
// so ownership isn't leaked via the error type.
export async function requireOwnedVehicle(ctx, vehicleId) {
  const user = requireUser(ctx);
  const vehicle = await getVehicleById(ctx.db, vehicleId);
  if (!vehicle || vehicle.userId !== user.id) {
    throw new GraphQLError("Vehicle not found", { extensions: { code: "NOT_FOUND" } });
  }
  return vehicle;
}
