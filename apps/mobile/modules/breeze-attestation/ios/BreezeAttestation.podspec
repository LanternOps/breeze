Pod::Spec.new do |s|
  s.name           = 'BreezeAttestation'
  s.version        = '1.0.0'
  s.summary        = 'Secure Enclave P-256 approver keys + App Attest for Breeze RMM.'
  s.description    = 'Local Expo module: hardware-attested approver key registration (#1374).'
  s.author         = ''
  s.homepage       = 'https://github.com/LanternOps/breeze'
  s.platforms      = { :ios => '15.1', :tvos => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
