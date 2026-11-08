import type { ThemeConfig } from 'antd';
export const theme: ThemeConfig = {
  token: {
    colorPrimary: '#262626', colorText: '#262626', colorTextSecondary: '#666666',
    colorSuccess: '#348267', colorWarning: '#a77c25', colorError: '#bf6057', colorInfo: '#666666',
    colorSuccessBg: '#f0f7f3', colorSuccessBgHover: '#e3f0e9', colorSuccessBorder: '#dcebe2', colorSuccessBorderHover: '#aacdbb',
    colorSuccessText: '#286b51', colorSuccessTextHover: '#348267', colorSuccessTextActive: '#20563f',
    colorInfoBg: '#f5f5f5', colorInfoBorder: '#e8e8e8',
    colorBorder: '#dddddd', colorBorderSecondary: '#e8e8e8', colorBgLayout: '#ffffff',
    colorBgContainer: '#ffffff', borderRadius: 6, fontSize: 14, controlHeight: 44,
    fontFamily: 'Manrope, "PingFang SC", "Microsoft YaHei", sans-serif',
  },
  components: {
    Button: { primaryShadow: 'none', defaultShadow: 'none' },
    Table: { headerBg: 'transparent', headerColor: '#666666', headerSplitColor: 'transparent', cellPaddingBlock: 20, cellPaddingInline: 16, rowHoverBg: '#f7f7f7' },
    Tooltip: { colorBgSpotlight: '#fff', colorTextLightSolid: '#262626' },
    Radio: { buttonBg: '#f5f5f5', buttonColor: '#666666', buttonSolidCheckedBg: '#262626', buttonSolidCheckedHoverBg: '#404040', buttonSolidCheckedActiveBg: '#181818', buttonSolidCheckedColor: '#fff' },
  },
};
