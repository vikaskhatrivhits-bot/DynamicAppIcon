#import <React/RCTBridgeModule.h>

// Exposes the Swift AppIconModule (AppIconModule.swift) to JavaScript. Under the New
// Architecture this legacy module is loaded through React Native's TurboModule interop layer,
// which RCTRootViewFactory enables by default in bridgeless mode.
@interface RCT_EXTERN_MODULE(AppIconModule, NSObject)

RCT_EXTERN_METHOD(getIcon : (RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(setIcon : (NSString *)icon resolver : (RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject)

@end
