import { requireOwnedVehicle } from "./helpers.js";

export const Query = {
  me: (_, __, ctx) => ctx.user,
  vehicle: (_, { id }, ctx) => requireOwnedVehicle(ctx, id),
};
