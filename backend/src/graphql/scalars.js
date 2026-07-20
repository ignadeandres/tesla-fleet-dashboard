import { GraphQLScalarType, Kind } from "graphql";

export const DateTimeScalar = new GraphQLScalarType({
  name: "DateTime",
  description: "ISO-8601 timestamp",
  serialize: (value) => new Date(value).toISOString(),
  parseValue: (value) => new Date(value),
  parseLiteral: (ast) => (ast.kind === Kind.STRING ? new Date(ast.value) : null),
});

export const JSONScalar = new GraphQLScalarType({
  name: "JSON",
  description: "Arbitrary JSON value",
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: function parseLiteral(ast) {
    switch (ast.kind) {
      case Kind.OBJECT:
        return Object.fromEntries(ast.fields.map((f) => [f.name.value, parseLiteral(f.value)]));
      case Kind.LIST:
        return ast.values.map(parseLiteral);
      case Kind.STRING:
      case Kind.ENUM:
        return ast.value;
      case Kind.INT:
      case Kind.FLOAT:
        return Number(ast.value);
      case Kind.BOOLEAN:
        return ast.value;
      default:
        return null;
    }
  },
});
