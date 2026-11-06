import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { collectFactoryUsage } from "./src/factory-usage.js";
import { usageHostContract } from "./src/usage-contract.js";

export default experimental_defineHostEntry({
  contract: usageHostContract,
  handlers: {
    collectUsage: ({ apiKey }, context) => collectFactoryUsage({ apiKey, signal: context.signal }),
  },
});
