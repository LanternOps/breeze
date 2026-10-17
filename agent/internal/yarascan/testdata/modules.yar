import "pe"
import "elf"
import "hash"
import "math"
rule fixture_modules_load { condition: filesize >= 0 and math.entropy(0, 0) >= 0 }
