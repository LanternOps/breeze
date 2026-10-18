/*
 * YARA-Forge YARA Rule Package
 * https://github.com/YARAHQ/yara-forge
 *
 * Rule Package Information
 * Name: core
 * Number of Rules: 21
 */

import "pe"
import "cuckoo"


/*
 * YARA Rule Set
 * Repository Name: AllowApache
 * Repository: https://example.invalid/allow-apache/
 * Number of Rules: 8
 *
 *
 * LICENSE
 *
 *
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   Copyright 2023 Example Apache Authors
 */

rule ALLOWAPACHE_Ok : FILE
{
	meta:
		description = "plain apache rule"
		author = "fixture"
		score = 80
		quality = 90
	strings:
		$a = "breeze_fixture_apache_ok"
	condition:
		$a
}

rule ALLOWAPACHE_Pe : FILE
{
	meta:
		description = "uses the pe module"
		score = 95
		quality = 80
	strings:
		$a = "breeze_fixture_pe"
	condition:
		uint16(0) == 0x5a4d and pe.number_of_sections > 1 and $a
}

rule ALLOWAPACHE_Cuckoo
{
	meta:
		score = 80
		quality = 80
	condition:
		cuckoo.network.http_request(/evil/)
}

private rule ALLOWAPACHE_Private
{
	condition:
		filesize > 10
}

rule ALLOWAPACHE_Denied : FILE
{
	meta:
		score = 80
		quality = 80
	strings:
		$a = "breeze_fixture_denied"
	condition:
		$a
}

rule ALLOWAPACHE_CompileError
{
	meta:
		score = 80
		quality = 80
	strings:
		$a = "FAKE_COMPILE_ERROR"
	condition:
		$a
}

rule ALLOWAPACHE_LowScore
{
	meta:
		score = 40
		quality = 80
	strings:
		$a = "breeze_fixture_low"
	condition:
		$a
}

rule ALLOWAPACHE_Tricky : FILE
{
	meta:
		description = "escapes: <tag> & \"quoted\" back\\slash café — dash"
		score = 60
		quality = 70
	strings:
		$a = "a<b>&c\tz" ascii
		$b = { 4D 5A ?? 00 }
	condition:
		any of them
}

rule ALLOWAPACHE_LineSeparator
{
	meta:
		description = "contains a U+2028 here:  "
		score = 80
		quality = 80
	strings:
		$a = "x"
	condition:
		$a
}

/*
 * YARA Rule Set
 * Repository Name: MitRepo
 * Repository: https://example.invalid/mit/
 * Number of Rules: 1
 *
 *
 * LICENSE
 *
 * MIT License

Copyright (c) 2022 Example MIT Author

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction.
 */

rule MITREPO_Ok
{
	meta:
		score = 75
		quality = 75
	strings:
		$a = "breeze_fixture_mit"
	condition:
		$a
}

/*
 * YARA Rule Set
 * Repository Name: BsdTwo
 * Repository: https://example.invalid/bsd2/
 * Number of Rules: 2
 *
 *
 * LICENSE
 *
 * Copyright 2021 by Example BSD2.

The 2-Clause BSD License

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
 */

rule BSDTWO_Ok
{
	meta:
		score = 75
		quality = 75
		license = "See license at https://example.invalid/bsd2/LICENSE"
	strings:
		$a = "breeze_fixture_bsd2"
	condition:
		$a
}

rule BSDTWO_MetaDrl
{
	meta:
		score = 75
		quality = 75
		license = "DRL-1.1"
	strings:
		$a = "breeze_fixture_bsd2_drl"
	condition:
		$a
}

/*
 * YARA Rule Set
 * Repository Name: BsdThree
 * Repository: https://example.invalid/bsd3/
 * Number of Rules: 1
 *
 *
 * LICENSE
 *
 * Copyright (c) 2020, Example BSD3
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice.
2. Redistributions in binary form must reproduce the above copyright notice.
3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.
 */

rule BSDTHREE_Ok
{
	meta:
		score = 75
		quality = 75
	strings:
		$a = "breeze_fixture_bsd3"
	condition:
		$a
}

/*
 * YARA Rule Set
 * Repository Name: Cc0Repo
 * Repository: https://example.invalid/cc0/
 * Number of Rules: 1
 *
 *
 * LICENSE
 *
 * CC0 1.0 Universal

Statement of Purpose
 */

rule CC0REPO_Ok
{
	meta:
		score = 75
		quality = 75
	strings:
		$a = "breeze_fixture_cc0"
	condition:
		$a
}

/*
 * YARA Rule Set
 * Repository Name: ElasticRepo
 * Repository: https://example.invalid/elastic/
 * Number of Rules: 1
 *
 *
 * LICENSE
 *
 * Elastic License 2.0

URL: https://www.elastic.co/licensing/elastic-license
 */

rule ELASTICREPO_X
{
	meta:
		score = 75
		quality = 75
	strings:
		$a = "breeze_fixture_elastic"
	condition:
		$a
}

/*
 * YARA Rule Set
 * Repository Name: DrlRepo
 * Repository: https://example.invalid/drl/
 * Number of Rules: 1
 *
 *
 * LICENSE
 *
 * # Detection Rule License (DRL) 1.1

Permission is hereby granted, free of charge, to any person obtaining a copy
of this rule set and associated documentation files (the "Rules").
 */

rule DRLREPO_X
{
	meta:
		score = 75
		quality = 75
	strings:
		$a = "breeze_fixture_drl"
	condition:
		$a
}

/*
 * YARA Rule Set
 * Repository Name: GplRepo
 * Repository: https://example.invalid/gpl/
 * Number of Rules: 1
 *
 *
 * LICENSE
 *
 * GNU GENERAL PUBLIC LICENSE
                       Version 3, 29 June 2007
 */

rule GPLREPO_X
{
	meta:
		score = 75
		quality = 75
	strings:
		$a = "breeze_fixture_gpl"
	condition:
		$a
}

/*
 * YARA Rule Set
 * Repository Name: NoLicense
 * Repository: https://example.invalid/none/
 * Number of Rules: 3
 *
 *
 * LICENSE
 *
 * NO LICENSE SET
 */

rule NOLICENSE_X
{
	meta:
		score = 75
		quality = 75
	strings:
		$a = "breeze_fixture_nolicense"
	condition:
		$a
}

rule NOLICENSE_MetaMit
{
	meta:
		score = 75
		quality = 75
		license = "MIT"
	strings:
		$a = "breeze_fixture_nolicense_mit"
	condition:
		$a
}

rule NOLICENSE_MetaCcBy
{
	meta:
		score = 75
		quality = 75
		license = "CC BY 4.0"
	strings:
		$a = "breeze_fixture_ccby"
	condition:
		$a
}
