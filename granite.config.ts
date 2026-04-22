import { appsInToss } from '@apps-in-toss/framework/plugins';
import { defineConfig } from '@granite-js/react-native/config';

export default defineConfig({
  scheme: 'intoss',
  appName: 'eomma-yak-meokja',
  plugins: [
    appsInToss({
      brand: {
        displayName: '엄마약먹자',
        primaryColor: '#FF6B6B',
        icon: 'https://static.toss.im/appsintoss/34823/46e5306e-789d-4295-ab7b-00dec2a4e6b2.png',
      },
      permissions: [],
    }),
  ],
});
