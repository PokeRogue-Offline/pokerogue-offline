require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'OtaUnzip'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = 'https://github.com/PokeRogue-Offline/pokerogue-offline'
  s.author = 'PokeRogue-Offline'
  s.source = { :git => 'https://github.com/PokeRogue-Offline/pokerogue-offline.git' }
  s.source_files = 'ios/Sources/**/*.{swift,h,m,c,cc,mm,cpp}'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  # Pulled in transitively, same mechanism @capgo/capacitor-social-login
  # already uses to pull in GoogleSignIn in this same build.
  s.dependency 'ZIPFoundation', '~> 0.9'
  s.swift_version = '5.1'
end
