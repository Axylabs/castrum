// check-native.ts
import addon from "./src/native";

const IngressCtor = (addon as any).Ingress;

if (typeof IngressCtor !== "function") {
  throw new Error("Native Ingress class missing");
}

const instance = new IngressCtor({});

console.log(
  Object.getOwnPropertyNames(Object.getPrototypeOf(instance)),
);