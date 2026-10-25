export function assertRedistributionLicenses(
  components: readonly {
    name?: string
    licenses?: readonly { license?: { id?: string; name?: string } }[]
  }[],
): void {
  for (const component of components) {
    for (const entry of component.licenses ?? []) {
      const license = entry.license?.id ?? entry.license?.name ?? ""
      if (/LGPL/i.test(license))
        throw new Error(
          `REDISTRIBUTION FAIL: LGPL component needs compliance review: ${component.name}`,
        )
      if (!license) throw new Error(`SBOM component has no license: ${component.name}`)
    }
  }
}
