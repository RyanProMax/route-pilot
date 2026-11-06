import type { ThemeConfig } from 'antd';
export const theme: ThemeConfig = {
  token: {
    colorPrimary: '#6476ae', colorText: '#1c2638', colorTextSecondary: '#65718a',
    colorBorder: '#dce2ec', colorBorderSecondary: '#e9edf4', colorBgLayout: '#fafbfd',
    colorBgContainer: '#ffffff', borderRadius: 8, fontSize: 14,
    fontFamily: 'Manrope, "PingFang SC", "Microsoft YaHei", sans-serif',
  },
  components: {
    Table: { headerBg: 'transparent', headerColor: '#65718a', headerSplitColor: 'transparent', cellPaddingBlock: 20, cellPaddingInline: 16, rowHoverBg: '#f7f9fc' },
    Segmented: { trackBg: '#f0f3f8', itemSelectedBg: '#6476ae', itemSelectedColor: '#fff', itemHoverBg: '#e6ebf4', boxShadowTertiary: 'none' },
    Tooltip: { colorBgSpotlight: '#fff', colorTextLightSolid: '#1c2638' },
  },
};
