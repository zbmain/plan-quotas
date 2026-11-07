import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountSummary, formatAccountCount } from "./AccountSummary";

describe("账号概览", () => {
  it("准确显示总数、可用和不可用数量，包括空账户", () => {
    for (const [total, available] of [
      [6, 5],
      [6, 6],
      [0, 0],
    ]) {
      const html = renderToStaticMarkup(
        <AccountSummary total={total} available={available} loading={false} />,
      );
      expect(html).toContain(`aria-label="已接入账号 ${total} 个"`);
      expect(html).toContain(`aria-label="可用 ${available} 个"`);
      expect(html).toContain(`aria-label="不可用 ${total - available} 个"`);
    }
  });

  it("加载和请求失败不会显示虚假的零值", () => {
    const loading = renderToStaticMarkup(<AccountSummary loading />);
    expect(loading).toContain('aria-busy="true"');
    expect(loading.match(/summary-placeholder/g)).toHaveLength(3);
    const missing = renderToStaticMarkup(<AccountSummary loading={false} />);
    expect(missing.match(/暂无数据/g)).toHaveLength(3);
    expect(missing).not.toContain("0 个");
  });

  it("紧凑显示万级计数，同时为辅助技术保留准确数量", () => {
    expect(formatAccountCount(9999)).toBe("9999");
    expect(formatAccountCount(12345)).toBe("1.2万");
    expect(formatAccountCount(123456)).toBe("12万");
    const html = renderToStaticMarkup(
      <AccountSummary total={12345} available={10000} loading={false} />,
    );
    expect(html).toContain("1.2万");
    expect(html).toContain('aria-label="已接入账号 12345 个"');
    expect(html).toContain('aria-label="不可用 2345 个"');
  });
});
