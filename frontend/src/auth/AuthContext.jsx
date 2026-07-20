import { createContext, useContext } from "react";
import { useQuery, useMutation } from "@apollo/client";
import { ME_QUERY, LOGIN_MUTATION, REGISTER_MUTATION, LOGOUT_MUTATION } from "../graphql/queries/auth.js";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const { data, loading, refetch } = useQuery(ME_QUERY, { fetchPolicy: "network-only" });
  const [loginMutation] = useMutation(LOGIN_MUTATION);
  const [registerMutation] = useMutation(REGISTER_MUTATION);
  const [logoutMutation] = useMutation(LOGOUT_MUTATION);

  const value = {
    user: data?.me || null,
    loading,
    async login(email, password) {
      await loginMutation({ variables: { email, password } });
      await refetch();
    },
    async register(email, password) {
      await registerMutation({ variables: { email, password } });
      await refetch();
    },
    async logout() {
      await logoutMutation();
      await refetch();
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
