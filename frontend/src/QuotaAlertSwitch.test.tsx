import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QuotaAlertSwitch } from "./QuotaAlertSwitch";

describe("额度预警开关", () => {
  it("提供独立的开关和默认隐藏的功能说明", () => {
    const html = renderToStaticMarkup(
      <QuotaAlertSwitch
        enabled={false}
        pending={false}
        hint=""
        onToggle={() => {}}
      />,
    );
    expect(html).toContain('role="switch" aria-checked="false"');
    expect(html).toContain("额度预警");
    expect(html).toContain('aria-label="额度预警说明"');
    expect(html).toContain('role="tooltip" hidden=""');
    expect(html).toContain("周期额度剩余 20%、10%、0% 时会收到提醒");
  });

  it("将权限提示关联到开关", () => {
    const html = renderToStaticMarkup(
      <QuotaAlertSwitch
        enabled
        pending
        hint="请允许浏览器通知"
        onToggle={() => {}}
      />,
    );
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("aria-describedby=");
    expect(html).toContain('disabled=""');
    expect(html).toContain("请允许浏览器通知");
  });
});
