import type { ThemeConfig } from "antd";
export const theme: ThemeConfig = {
  token: {
    colorPrimary: "#244b3f",
    colorText: "#22392f",
    colorTextSecondary: "#627168",
    colorBorderSecondary: "#e9edea",
    colorBgLayout: "#ffffff",
    borderRadius: 8,
    fontFamily: 'Manrope, "PingFang SC", "Microsoft YaHei", sans-serif',
    fontSize: 14,
  },
  components: {
    Table: {
      headerBg: "#ffffff",
      headerColor: "#627168",
      headerSplitColor: "transparent",
      cellPaddingBlock: 21,
      cellPaddingInline: 16,
      rowHoverBg: "#ffffff",
    },
    Segmented: {
      trackBg: "#f2f4f3",
      itemSelectedBg: "#ffffff",
      itemSelectedColor: "#22392f",
      itemHoverBg: "transparent",
      itemActiveBg: "transparent",
      boxShadowTertiary: "none",
    },
    Tooltip: { colorBgSpotlight: "#ffffff", colorTextLightSolid: "#22392f" },
    Radio: {
      buttonBg: "#f2f5f3",
      buttonColor: "#53665b",
      buttonSolidCheckedBg: "#244b3f",
      buttonSolidCheckedHoverBg: "#305e50",
      buttonSolidCheckedActiveBg: "#1d3d33",
      buttonSolidCheckedColor: "#ffffff",
    },
  },
};
