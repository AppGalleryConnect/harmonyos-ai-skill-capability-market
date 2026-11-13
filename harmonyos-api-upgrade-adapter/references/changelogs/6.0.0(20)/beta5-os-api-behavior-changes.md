---
title: OS平台API行为的变更
source: https://developer.huawei.com/consumer/cn/doc/harmonyos-releases/changelogs-for-all-apps-6004
category: harmonyos-releases
downloaded_at: 2026-09-03
---

# OS平台API行为的变更

## ArkTS

### 禁止在编译产物为JS的HAR包中使用注解

**变更原因**

应用开发中，在[release模式下构建](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-hvigor-build-har#section19788284410)源码HAR，并同时[开启混淆](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/source-obfuscation)时，由于编译产物为JS文件，而在JS中没有注解的实现机制，因此会在编译过程中被移除，导致无法通过注解实现AOP插桩。

为避免因此引起的功能异常，禁止在JS HAR(编译产物中存在JS的HAR包)中使用注解。

**变更影响**

此变更涉及应用适配。

变更前：构建JS HAR时，若代码中存在注解，编译不会报错。

如下代码在JS形态的HAR包中编译时不会报错。

```typescript
// test.ets
@interface ClassAuthor {
  authorName: string
}

@ClassAuthor({authorName: "Bob"})
class MyClass {
  /* body */
}
```

变更后：构建JS HAR时，若代码中存在注解，编译会报错。

**起始API Level**

不涉及

**变更的接口/组件**

不涉及

**适配指导**

删除JS HAR中的注解声明和调用，或者重新编译成其他形态的HAR包，例如[字节码HAR](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-hvigor-build-har#section16598338112415)。