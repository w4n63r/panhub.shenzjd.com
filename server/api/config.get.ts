import { defineEventHandler } from "h3";

export default defineEventHandler((event) => {
  // 从运行环境变量读取基础模式状态
  // 在 Vercel 后台配置 IS_BASIC_MODE="true" 开启备忘录模式，设为 "false" 或删除则恢复高级搜索
  const isBasicMode = process.env.IS_BASIC_MODE === 'true';

  return {
    code: 0,
    data: {
      isBasicMode
    }
  };
});
