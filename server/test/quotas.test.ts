import { readFileSync } from "node:fs";
import { it, expect } from "vitest";
import { buildResponse, historyResponse } from "../src/quota-protocol.js";
import { buildQuotaList, quotaSummary } from "../src/quota-view.js";
import { openDesignUsage } from "../src/adapters/opendesign.js";
import { AdapterError } from "../src/adapters/base.js";

for (const name of ["quotas", "views"])
  for (const [index, row] of JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  ).entries())
    it(`${name} exact reference projection ${index}`, () => {
      const fn = (
        {
          build_response: buildResponse,
          history_response: historyResponse,
          build_quota_list: buildQuotaList,
          quota_summary: quotaSummary,
        } as Record<string, any>
      )[row.fn];
      const args = [...row.args];
      if (Object.keys(row.kwargs).length) args.push(row.kwargs);
      expect(fn(...args)).toEqual(row.expected);
    });
for (const [index, row] of JSON.parse(
  readFileSync(
    new URL("./fixtures/opendesign-usage.json", import.meta.url),
    "utf8",
  ),
).entries())
  it(`OpenDesign precision/workspace validation ${index}`, () => {
    if (row.error) {
      expect(() => openDesignUsage(row.args[0], row.args[1])).toThrowError(
        new AdapterError(row.error),
      );
      return;
    }
    const actual = openDesignUsage(row.args[0], row.args[1]);
    expect({ ...actual, fetched_at: null }).toEqual({
      ...row.result,
      fetched_at: null,
    });
  });
