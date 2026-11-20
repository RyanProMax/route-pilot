import { theme as antTheme, type ThemeConfig } from 'antd';

export function componentTheme(light: boolean): ThemeConfig {
  const style = getComputedStyle(document.documentElement);
  const color = (name: string) => style.getPropertyValue('--rp-' + name).trim();
  return {
    algorithm: light ? antTheme.defaultAlgorithm : antTheme.darkAlgorithm,
    token: {
      colorPrimary: color('accent'), colorInfo: color('accent'), colorLink: color('accent'),
      colorSuccess: color('ok'), colorWarning: color('warning'), colorError: color('down'),
      colorText: color('ink'), colorTextSecondary: color('muted'),
      colorBgBase: color('canvas'), colorBgLayout: color('canvas'),
      colorBgContainer: color('surface'), colorBgElevated: color('elevated'),
      colorBorder: color('line'), colorBorderSecondary: color('line'),
      borderRadius: 10, borderRadiusLG: 18, controlHeight: 40, fontSize: 14,
      fontFamily: 'Manrope, "PingFang SC", "Microsoft YaHei", sans-serif',
    },
    components: {
      Button: {
        colorPrimary: color('action'), colorPrimaryHover: '#404040', colorPrimaryActive: '#181818',
        primaryColor: '#fff', primaryShadow: light ? 'none' : 'inset 0 0 0 1px #686868',
        defaultHoverColor: color('ink'), defaultHoverBorderColor: color('muted'),
        defaultActiveColor: color('ink'), defaultActiveBorderColor: color('accent'), defaultShadow: 'none',
      },
      Menu: { itemBg: 'transparent', horizontalItemSelectedBg: '#000', horizontalItemSelectedColor: '#fff' },
      Table: { headerBg: 'transparent', headerColor: color('muted'), headerSplitColor: 'transparent',
        cellPaddingBlock: 16, cellPaddingInline: 16, rowHoverBg: color('selected') },
      Tooltip: { colorBgSpotlight: color('elevated'), colorTextLightSolid: color('ink') },
    },
  };
}
