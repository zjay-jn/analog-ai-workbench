; Independent bounded oracle. Definitions only; root's fresh-session wrapper
; calls aawRunIndependentOracle(). Never load the production reader here.
; No master/CDF access, save or GUI action. Unknown pins are not ordinal-matched.
procedure(aawOracleRequire(condition code)
  unless(condition error("AAW_OA_ORACLE_%s\n" code))
)
procedure(aawOracleRecord(port row)
  let((encoded)
    encoded = sprintf(nil "%L" row)
    aawOracleRequire(strlen(encoded) <= 16384 "RECORD_LIMIT")
    fprintf(port "%s\n" encoded)
  )
)
procedure(aawRunIndependentOracle()
  let((outPath suffix captureRoot expectedLibrary library viewObject cv out result
        devices selectedNets device selectedNet properties parameterCount
        deviceTerminalCount vinInstanceCount vinPortCount totalTerminals)
    aawOracleRequire(getShellEnvVar("WSL_DISTRO_NAME") == "ROCKY9_LLM_LAB" "ENVIRONMENT_SCOPE")
    outPath = getShellEnvVar("AAW_OA_ORACLE_OUT")
    unless(outPath outPath = getShellEnvVar("AAW_OA_RESULT_PATH"))
    aawOracleRequire(stringp(outPath) "OUTPUT_REQUIRED")
    aawOracleRequire(rexMatchp("^/mnt/c/work/analog_ai_workbench/[.]local/oa-read/captures/[A-Za-z0-9_-][A-Za-z0-9_-]*/oracle/oracle[.]sexp$" outPath) "OUTPUT_SCOPE")
    suffix = "/oracle/oracle.sexp"
    captureRoot = substring(outPath 1 strlen(outPath)-strlen(suffix))
    aawOracleRequire(getWorkingDir() == strcat(captureRoot "/oracle") "CWD_SCOPE")
    aawOracleRequire(!isFile(outPath) "OUTPUT_ALREADY_EXISTS")
    expectedLibrary = strcat(captureRoot "/source/FOLDED_CASCODE")
    library = ddGetObj("FOLDED_CASCODE")
    aawOracleRequire(library && library~>readPath == expectedLibrary "LIBRARY_MAPPING")
    viewObject = ddGetObj("FOLDED_CASCODE" "FOLDED_CASCODE" "schematic")
    aawOracleRequire(viewObject && viewObject~>readPath == strcat(expectedLibrary "/FOLDED_CASCODE/schematic") "VIEW_MAPPING")
    cv = nil
    out = nil
    parameterCount = 0
    deviceTerminalCount = 0
    vinInstanceCount = 0
    vinPortCount = 0
    totalTerminals = 0
    result = errset(progn(
      cv = dbOpenCellViewByType("FOLDED_CASCODE" "FOLDED_CASCODE" "schematic" "" "r")
      aawOracleRequire(cv "OPEN_FAILED")
      aawOracleRequire(cv~>libName == "FOLDED_CASCODE" && cv~>cellName == "FOLDED_CASCODE" && cv~>viewName == "schematic" "LCV_MISMATCH")
      aawOracleRequire(length(cv~>instances) <= 256 && length(cv~>nets) <= 256 && length(cv~>terminals) <= 256 "OBJECT_LIMIT")
      devices = setof(candidate cv~>instances candidate~>name == "M1")
      selectedNets = setof(candidate cv~>nets candidate~>name == "VIN")
      aawOracleRequire(length(devices) == 1 "M1_MISSING_OR_AMBIGUOUS")
      aawOracleRequire(length(selectedNets) == 1 "VIN_MISSING_OR_AMBIGUOUS")
      device = car(devices)
      selectedNet = car(selectedNets)
      properties = device~>prop
      aawOracleRequire(length(properties) > 0 && length(properties) <= 64 "M1_PARAMETER_SCOPE")
      aawOracleRequire(length(device~>instTerms) <= 32 "M1_TERMINAL_LIMIT")
      out = outfile(outPath)
      aawOracleRequire(out "OUTPUT_OPEN_FAILED")
      aawOracleRecord(out list("meta" "aaw.oa-independent-oracle.v1" "FOLDED_CASCODE" "FOLDED_CASCODE" "schematic" "M1" "VIN"))
      aawOracleRecord(out list("device" device~>name device~>libName device~>cellName device~>viewName))
      foreach(property properties
        let((typeText valueText)
          aawOracleRequire(stringp(property~>name) "PROPERTY_NAME")
          typeText = sprintf(nil "%L" type(property~>value))
          valueText = sprintf(nil "%L" property~>value)
          aawOracleRequire(strlen(valueText) <= 4096 "PROPERTY_VALUE_LIMIT")
          aawOracleRecord(out list("parameter" "M1" property~>name typeText valueText))
          parameterCount = parameterCount + 1
        )
      )
      ; M1 forward relation uses only the instance-terminal's own net pointer.
      foreach(terminal device~>instTerms
        aawOracleRecord(out list("device_terminal" "M1" if(terminal~>net then "present" else "none") if(terminal~>net then terminal~>net~>name else nil)))
        deviceTerminalCount = deviceTerminalCount + 1
      )
      ; Independent VIN members: scan instance terminals instead of the net's
      ; members. Compare instance-name multiplicity, never unknown pin ordinals.
      foreach(instance cv~>instances
        aawOracleRequire(length(instance~>instTerms) <= 32 "INSTANCE_TERMINAL_LIMIT")
        totalTerminals = totalTerminals + length(instance~>instTerms)
        aawOracleRequire(totalTerminals <= 1024 "TOTAL_TERMINAL_LIMIT")
        foreach(terminal instance~>instTerms
          when(eq(terminal~>net selectedNet)
            aawOracleRequire(stringp(instance~>name) "INSTANCE_NAME")
            aawOracleRequire(length(setof(peer cv~>instances peer~>name == instance~>name)) == 1 "VIN_INSTANCE_NAME_AMBIGUOUS")
            aawOracleRecord(out list("vin_instance_terminal" "VIN" instance~>name))
            vinInstanceCount = vinInstanceCount + 1
          )
        )
      )
      foreach(terminal cv~>terminals
        when(eq(terminal~>net selectedNet)
          aawOracleRequire(stringp(terminal~>name) "PORT_NAME")
          aawOracleRecord(out list("vin_port" "VIN" terminal~>name sprintf(nil "%L" terminal~>direction)))
          vinPortCount = vinPortCount + 1
        )
      )
      aawOracleRequire(vinInstanceCount > 0 "VIN_NO_INSTANCE_MEMBERS")
      aawOracleRecord(out list("done" parameterCount deviceTerminalCount vinInstanceCount vinPortCount "dirty_unknown" "terminal_names_and_roles_unknown"))
      t
    ) t)
    when(out close(out))
    when(cv dbClose(cv))
    aawOracleRequire(result && car(result) "FAILED_OR_INCOMPLETE")
    t
  )
)
